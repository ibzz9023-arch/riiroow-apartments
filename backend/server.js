import express from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import {
  generateTenantPin,
  verifyTenantPin,
  requireTenantQrSession,
} from './src/tenantQrAuth.js';
import {
  submitTenantPaymentNotification,
  listManagerPaymentNotifications,
  reviewPaymentNotification,
} from './src/paymentNotifications.js';
import {
  submitTenantMoveOutRequest,
  listManagerMoveOutRequests,
  reviewMoveOutRequest,
} from './src/moveOutRequests.js';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEntity,
  createLease,
  createPayment,
  createTenant,
  deleteEntity,
  getDashboard,
  getLeases,
  getMaintenance,
  getPayments,
  getTenants,
  getTenantPayments,
  getTenantPhotoRecord,
  updateTenantPhotoStoragePath,
  getUnits,
  getUsers,
  loginUser,
  updateEntity,
  updateLease,
  updatePayment,
  updateTenant,
  terminateLease,
} from './src/dataService.js';
import { hasSupabase, supabase, supabaseServiceRole } from './src/supabaseClient.js';
import {
  LEASE_DOCUMENT_TOKEN_PATTERN,
  createLeaseDocumentNonce,
  deriveLeaseDocumentToken,
  hashLeaseDocumentToken,
  leaseDocumentTokenMatchesHash,
} from './src/leaseDocumentTokens.js';
import {
  createSessionToken,
  getSessionSecret,
  requireRoles,
} from './src/authSession.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDist = path.resolve(__dirname, '../frontend/dist');

const app = express();

// Railway runs the app behind its trusted ingress proxy.
app.set('trust proxy', 1);
const port = Number(process.env.PORT || 5000);

// Basic production security headers.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  const isLeaseDocumentPage = req.path.startsWith('/lease-documents/');
  res.setHeader('Referrer-Policy', isLeaseDocumentPage ? 'no-referrer' : 'strict-origin-when-cross-origin');
  if (isLeaseDocumentPage) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(cors());
app.use(express.json());

const QR_MEDIA_BUCKET = 'maintenance-evidence';
const QR_MEDIA_LIMITS = {
  photo: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  audio: 10 * 1024 * 1024,
};
const QR_MEDIA_MIME_TYPES = {
  photo: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp', 'video/3gpp2', 'video/x-m4v', 'video/ogg', 'video/x-matroska']),
  audio: new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/3gpp', 'audio/3gpp2', 'audio/flac']),
};
const QR_MEDIA_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
  'video/3gpp2': '3g2',
  'video/x-m4v': 'm4v',
  'video/ogg': 'ogv',
  'video/x-matroska': 'mkv',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'audio/3gpp': '3gp',
  'audio/3gpp2': '3g2',
  'audio/flac': 'flac',
};
const qrMaintenanceMultipart = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 3,
    fileSize: QR_MEDIA_LIMITS.video,
    fields: 3,
    fieldSize: 25 * 1024,
  },
  fileFilter: (req, file, callback) => {
    const mimeType = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (!QR_MEDIA_MIME_TYPES[file.fieldname]?.has(mimeType)) {
      const error = Object.assign(new Error(`Unsupported ${file.fieldname} file type.`), { statusCode: 400 });
      return callback(error);
    }
    callback(null, true);
  },
}).fields([
  { name: 'photo', maxCount: 1 },
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
]);

const parseQrMaintenanceMultipart = (req, res, next) => {
  qrMaintenanceMultipart(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      const limit = QR_MEDIA_LIMITS[error.field] || QR_MEDIA_LIMITS.video;
      const sizeInMb = limit / (1024 * 1024);
      return res.status(413).json({ error: `${error.field || 'Media'} exceeds the ${sizeInMb} MB file limit.` });
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Attach no more than one photo, one video, and one voice recording.' });
    }

    return res.status(error.statusCode || 400).json({ error: error.message || 'Invalid maintenance media upload.' });
  });
};

const LEASE_DOCUMENT_BUCKET = 'lease-documents';
const LEASE_DOCUMENT_MAX_SIZE = 10 * 1024 * 1024;
const LEASE_DOCUMENT_MAX_FILES = 5;
const LEASE_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);
const validUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const leaseDocumentsMultipart = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: LEASE_DOCUMENT_MAX_FILES,
    fileSize: LEASE_DOCUMENT_MAX_SIZE,
    fields: 2,
    fieldSize: 16 * 1024,
  },
  fileFilter: (req, file, callback) => {
    const mimeType = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (!LEASE_DOCUMENT_MIME_TYPES.has(mimeType)) {
      return callback(Object.assign(
        new Error('Only PDF, JPG, and PNG lease documents are allowed.'),
        { statusCode: 400 }
      ));
    }
    callback(null, true);
  },
}).array('documents', LEASE_DOCUMENT_MAX_FILES);

const parseLeaseDocumentsMultipart = (req, res, next) => {
  leaseDocumentsMultipart(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Each lease document must not exceed 10 MB.' });
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Upload no more than five documents at a time.' });
    }
    return res.status(error.statusCode || 400)
      .json({ error: error.message || 'Invalid lease document upload.' });
  });
};

const detectLeaseDocumentFormat = (buffer) => {
  if (buffer?.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') {
    return { mimeType: 'application/pdf', extension: 'pdf' };
  }
  if (buffer?.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    buffer?.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  return null;
};

const cleanLeaseDocumentName = (value) =>
  String(value || 'document')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255) || 'document';

const requireLeaseDocumentStorage = (res) => {
  if (supabaseServiceRole) return true;
  res.status(503).json({
    error: 'Private lease document storage is not configured. Configure the server service-role key and apply the lease documents migration.',
  });
  return false;
};

const findLeaseDocumentLease = async (leaseId) => {
  if (!validUuidPattern.test(String(leaseId || ''))) return null;
  const { data, error } = await supabaseServiceRole
    .from('leases')
    .select('id')
    .eq('id', leaseId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

const getLeaseDocumentTokenSecret = () => {
  const configured = String(process.env.LEASE_DOCUMENT_TOKEN_SECRET || '').trim();
  if (!configured) return getSessionSecret();

  if (!/^[A-Za-z0-9_-]+$/.test(configured)) {
    throw Object.assign(new Error('LEASE_DOCUMENT_TOKEN_SECRET must be canonical base64url.'), {
      code: 'LEASE_DOCUMENT_TOKEN_SECRET_INVALID',
    });
  }
  const secret = Buffer.from(configured, 'base64url');
  if (secret.length < 32 || secret.toString('base64url') !== configured) {
    throw Object.assign(new Error('LEASE_DOCUMENT_TOKEN_SECRET must contain at least 32 random bytes.'), {
      code: 'LEASE_DOCUMENT_TOKEN_SECRET_INVALID',
    });
  }
  return secret;
};

const createOrReadLeaseDocumentAccess = async (leaseId, { regenerate = false, allowCreate = true, createdBy = null } = {}) => {
  const secret = getLeaseDocumentTokenSecret();
  const { data: existing, error: readError } = await supabaseServiceRole
    .from('lease_document_access')
    .select('lease_id, token_hash, token_nonce, revoked_at')
    .eq('lease_id', leaseId)
    .maybeSingle();
  if (readError) throw readError;

  if (existing && !regenerate) {
    if (existing.revoked_at) {
      throw Object.assign(new Error('Lease document access has been revoked. A manager must regenerate the link.'), {
        code: 'LEASE_DOCUMENT_ACCESS_REVOKED',
      });
    }
    const token = deriveLeaseDocumentToken(leaseId, existing.token_nonce, secret);
    if (!leaseDocumentTokenMatchesHash(token, existing.token_hash)) {
      throw Object.assign(new Error('Lease document access key has changed. A manager must regenerate the link.'), {
        code: 'LEASE_DOCUMENT_TOKEN_KEY_MISMATCH',
      });
    }
    return token;
  }

  if (!existing && !allowCreate) {
    throw Object.assign(new Error('No lease document link exists yet. A manager must create it.'), {
      code: 'LEASE_DOCUMENT_ACCESS_NOT_FOUND',
    });
  }

  const nonce = createLeaseDocumentNonce();
  const token = deriveLeaseDocumentToken(leaseId, nonce, secret);
  const record = {
    lease_id: leaseId,
    token_hash: hashLeaseDocumentToken(token),
    token_nonce: nonce,
    revoked_at: null,
    created_by: createdBy,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await supabaseServiceRole
      .from('lease_document_access')
      .update(record)
      .eq('lease_id', leaseId)
      .select('lease_id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Lease document access record was not updated.');
    return token;
  }

  const { error: insertError } = await supabaseServiceRole
    .from('lease_document_access')
    .insert([{ ...record, created_at: new Date().toISOString() }]);
  if (!insertError) return token;

  // A concurrent first-time request may have inserted the row first.
  if (insertError.code === '23505') {
    const { data: raced, error: racedError } = await supabaseServiceRole
      .from('lease_document_access')
      .select('token_hash, token_nonce, revoked_at')
      .eq('lease_id', leaseId)
      .maybeSingle();
    if (racedError) throw racedError;
    if (raced && !raced.revoked_at) {
      const racedToken = deriveLeaseDocumentToken(leaseId, raced.token_nonce, secret);
      if (leaseDocumentTokenMatchesHash(racedToken, raced.token_hash)) return racedToken;
    }
  }
  throw insertError;
};

const signLeaseDocument = async (row) => {
  const bucket = supabaseServiceRole.storage.from(LEASE_DOCUMENT_BUCKET);
  const [{ data: previewData, error: previewError }, { data: downloadData, error: downloadError }] =
    await Promise.all([
      bucket.createSignedUrl(row.storage_path, 600),
      bucket.createSignedUrl(row.storage_path, 600, { download: row.original_name }),
    ]);
  if (previewError) throw previewError;
  if (downloadError) throw downloadError;
  return {
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    createdAt: row.created_at,
    previewUrl: previewData.signedUrl,
    downloadUrl: downloadData.signedUrl,
  };
};

const TENANT_PHOTO_BUCKET = 'tenant-photos';
const TENANT_PHOTO_MAX_SIZE = 5 * 1024 * 1024;

const tenantPhotoMultipart = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: TENANT_PHOTO_MAX_SIZE },
  fileFilter: (req, file, callback) => {
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
    const mimeType = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (!allowedTypes.has(mimeType)) {
      return callback(Object.assign(new Error('Only JPEG, PNG, and WebP photos are allowed.'), { statusCode: 400 }));
    }
    callback(null, true);
  },
}).single('photo');

const parseTenantPhotoMultipart = (req, res, next) => {
  tenantPhotoMultipart(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Tenant photo must not exceed 5 MB.' });
    }
    return res.status(error.statusCode || 400).json({ error: error.message || 'Invalid tenant photo upload.' });
  });
};

const detectTenantPhotoFormat = (buffer) => {
  if (buffer?.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (buffer?.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (buffer?.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
};

const tenantsWithPhotoUrls = async (tenants, includePhotoUrls = true) => Promise.all(
  (Array.isArray(tenants) ? tenants : []).map(async (tenant) => {
    const { photoStoragePath, ...publicTenant } = tenant;

    if (!includePhotoUrls || !photoStoragePath || !supabaseServiceRole) {
      return { ...publicTenant, photoUrl: null };
    }

    try {
      const { data, error } = await supabaseServiceRole
        .storage.from(TENANT_PHOTO_BUCKET)
        .createSignedUrl(photoStoragePath, 600);

      if (error) throw error;
      return { ...publicTenant, photoUrl: data?.signedUrl || null };
    } catch (photoError) {
      console.warn('Tenant photo URL could not be created:', photoError?.message || photoError);
      return { ...publicTenant, photoUrl: null };
    }
  })
);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Riiroow Apartment Management API is running.',
    database: hasSupabase ? 'supabase' : 'local-fallback',
  });
});

// Lightweight in-memory login protection.
// This protects the running API without changing the existing authentication flow.
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const loginRateLimit = (req, res, next) => {
  const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const current = loginAttempts.get(key);

  if (!current || now - current.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { firstAttempt: now, count: 1 });
    return next();
  }

  if (current.count >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({
      error: 'Too many login attempts. Please try again later.'
    });
  }

  current.count += 1;
  next();
};

app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  let secret;
  try {
    secret = getSessionSecret();
  } catch {
    return res.status(503).json({ error: 'Authentication is temporarily unavailable.' });
  }

  try {
    const { email, password } = req.body || {};
    const loginResult = await loginUser({ email, password });

    if (!loginResult) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    let token;
    try {
      token = createSessionToken(loginResult.user, { secret });
    } catch {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    return res.json({ ...loginResult, token });
  } catch (error) {
    console.error('Login could not be completed:', error.message || 'Authentication data unavailable.');
    return res.status(503).json({ error: 'Authentication is temporarily unavailable.' });
  }
});

app.get('/api/users', requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    const users = await getUsers();
    res.json(users.map((user) => Object.fromEntries(
      Object.entries(user).filter(([key]) => !/password/i.test(key))
    )));
  } catch (error) {
    console.error('Users fetch error:', error);
    res.status(500).json({ error: 'Unable to load users.' });
  }
});

app.get('/api/dashboard', requireRoles('Admin', 'Manager', 'Maintenance', 'Accountant'), async (req, res) => {
  try {
    const dashboard = await getDashboard();
    const roleCanViewTenantPhotos = ['admin', 'manager', 'accountant']
      .includes(String(req.auth?.role || '').toLowerCase());
    dashboard.tenants = await tenantsWithPhotoUrls(dashboard.tenants, roleCanViewTenantPhotos);
    res.json(dashboard);
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Unable to load dashboard.' });
  }
});

app.get('/api/units', requireRoles('Admin', 'Manager', 'Maintenance', 'Accountant'), async (req, res) => {
  try {
    res.json(await getUnits());
  } catch (error) {
    console.error('Units fetch error:', error);
    res.status(500).json({ error: 'Unable to load units.' });
  }
});

app.get('/api/tenants', requireRoles('Admin', 'Manager', 'Accountant'), async (req, res) => {
  try {
    res.json(await tenantsWithPhotoUrls(await getTenants()));
  } catch (error) {
    console.error('Tenants fetch error:', error);
    res.status(500).json({ error: 'Unable to load tenants.' });
  }
});

app.post('/api/tenants/:tenantId/photo', requireRoles('Admin', 'Manager'), parseTenantPhotoMultipart, async (req, res) => {
  let uploadedPath = null;
  let databaseUpdated = false;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Select a tenant photo to upload.' });
    }

    if (!supabaseServiceRole) {
      return res.status(503).json({ error: 'Private tenant photo storage is not configured.' });
    }

    const detected = detectTenantPhotoFormat(req.file.buffer);
    const claimedMime = String(req.file.mimetype || '').split(';')[0].trim().toLowerCase();

    if (!detected || detected.mimeType !== claimedMime) {
      return res.status(400).json({ error: 'The selected file is not a valid JPEG, PNG, or WebP image.' });
    }

    const tenant = await getTenantPhotoRecord(req.params.tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    const bucket = supabaseServiceRole.storage.from(TENANT_PHOTO_BUCKET);
    const previousPath = tenant.photo_storage_path || null;
    const newPath = `${req.params.tenantId}/${crypto.randomUUID()}.${detected.extension}`;

    const { error: uploadError } = await bucket.upload(newPath, req.file.buffer, {
      contentType: detected.mimeType,
      upsert: false,
    });
    if (uploadError) throw uploadError;

    uploadedPath = newPath;

    const { data: signedData, error: signedError } = await bucket.createSignedUrl(newPath, 600);
    if (signedError) throw signedError;

    const updatedTenant = await updateTenantPhotoStoragePath(req.params.tenantId, newPath);
    if (!updatedTenant) {
      throw Object.assign(new Error('Tenant not found.'), { statusCode: 404 });
    }

    databaseUpdated = true;

    if (previousPath && previousPath !== newPath) {
      const { error: removeError } = await bucket.remove([previousPath]);
      if (removeError) {
        console.warn('Previous tenant photo could not be removed:', removeError.message);
      }
    }

    return res.json({ success: true, photoUrl: signedData.signedUrl });
  } catch (error) {
    if (uploadedPath && !databaseUpdated && supabaseServiceRole) {
      try {
        await supabaseServiceRole.storage.from(TENANT_PHOTO_BUCKET).remove([uploadedPath]);
      } catch (cleanupError) {
        console.warn('Tenant photo upload cleanup failed:', cleanupError?.message || cleanupError);
      }
    }

    console.error('Tenant photo upload error:', error);
    const unavailable = ['TENANT_PHOTO_STORAGE_UNAVAILABLE', 'TENANT_PROPERTY_UNAVAILABLE'].includes(error.code);
    return res.status(error.statusCode || (unavailable ? 503 : 500))
      .json({ error: error.statusCode === 404 ? 'Tenant not found.' : 'Unable to save tenant photo.' });
  }
});
app.get('/api/tenants/:tenantId/payments', requireRoles('Admin', 'Manager', 'Accountant'), async (req, res) => {
  try {
    const result = await getTenantPayments(req.params.tenantId);
    if (!result) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }
    return res.json(result);
  } catch (error) {
    console.error('Tenant payments fetch error:', error);
    return res.status(500).json({ error: 'Unable to load tenant payments.' });
  }
});

app.get('/api/leases', requireRoles('Admin', 'Manager', 'Accountant'), async (req, res) => {
  try {
    res.json(await getLeases());
  } catch (error) {
    console.error('Leases fetch error:', error);
    res.status(500).json({ error: 'Unable to load leases.' });
  }
});

app.get('/api/payments', requireRoles('Admin', 'Manager', 'Accountant'), async (req, res) => {
  try {
    res.json(await getPayments());
  } catch (error) {
    console.error('Payments fetch error:', error);
    res.status(500).json({ error: 'Unable to load payments.' });
  }
});

app.get('/api/maintenance', requireRoles('Admin', 'Manager', 'Maintenance', 'Accountant'), async (req, res) => {
  try {
    res.json(await getMaintenance());
  } catch (error) {
    console.error('Maintenance fetch error:', error);
    res.status(500).json({ error: 'Unable to load maintenance requests.' });
  }
});

app.post('/api/units', requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    const item = await createEntity('units', {
      unit_number: Number(req.body.unitNumber ?? req.body.unit_number),
      floor: Number(req.body.floor),
      bedrooms: Number(req.body.bedrooms ?? 1),
      bathrooms: Number(req.body.bathrooms ?? 1),
      rent: Number(req.body.rent ?? 0),
      status: req.body.status ?? 'vacant',
      occupancy: req.body.occupancy ?? 'Vacant',
      last_payment_date: req.body.lastPaymentDate ?? null,
    });
    res.status(201).json(item);
  } catch (error) {
    console.error('Create unit error:', error);
    res.status(500).json({ error: 'Unable to create unit.' });
  }
});

app.post('/api/tenants', requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    const item = await createTenant({
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone,
      unit_id: req.body.unitId ?? null,
      unit_number: Number(req.body.unitNumber ?? req.body.unit_number),
      move_in_date: req.body.moveInDate ?? req.body.move_in_date,
      status: req.body.status ?? 'Active',
    });
    res.status(201).json(item);
  } catch (error) {
    console.error('Create tenant error:', error);
    res.status(500).json({ error: 'Unable to create tenant.' });
  }
});

app.patch('/api/tenants/:id', requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    const item = await updateTenant(req.params.id, {
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone,
      unit_id: req.body.unitId ?? null,
      unit_number: Number(req.body.unitNumber ?? req.body.unit_number),
      move_in_date: req.body.moveInDate ?? req.body.move_in_date,
      status: req.body.status,
    });
    res.json(item);
  } catch (error) {
    console.error('Update tenant error:', error);
    res.status(500).json({ error: 'Unable to update tenant.' });
  }
});

app.delete('/api/tenants/:id', requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    await deleteEntity('tenants', req.params.id);
    res.json({ success: true });
  } catch (error) {
    if (error?.code === 'TENANT_HAS_HISTORY') {
      return res.status(409).json({ error: error.message });
    }

    console.error('Delete tenant error:', error);
    res.status(500).json({ error: 'Unable to delete tenant.' });
  }
});

app.get('/api/public/lease-documents/:token', async (req, res) => {
  res.set({
    'Cache-Control': 'no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  });

  try {
    if (!requireLeaseDocumentStorage(res)) return;
    const token = String(req.params.token || '');
    if (!LEASE_DOCUMENT_TOKEN_PATTERN.test(token)) {
      return res.status(404).json({ error: 'This lease document link is invalid or no longer available.' });
    }

    const tokenHash = hashLeaseDocumentToken(token);
    const { data: access, error: accessError } = await supabaseServiceRole
      .from('lease_document_access')
      .select('lease_id')
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
      .maybeSingle();
    if (accessError) throw accessError;
    if (!access) {
      return res.status(404).json({ error: 'This lease document link is invalid or no longer available.' });
    }

    const { data: rows, error: documentsError } = await supabaseServiceRole
      .from('lease_documents')
      .select('id, original_name, mime_type, file_size, created_at, storage_path')
      .eq('lease_id', access.lease_id)
      .order('created_at', { ascending: false });
    if (documentsError) throw documentsError;

    const documents = await Promise.all((rows || []).map(signLeaseDocument));
    return res.json({ documents });
  } catch (error) {
    console.error('Public lease documents fetch error:', error?.message || error);
    return res.status(500).json({
      error: 'Unable to load these lease documents. Please contact property management.',
    });
  }
});

app.get('/api/leases/:id/documents', requireRoles('Admin', 'Manager', 'Accountant'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!requireLeaseDocumentStorage(res)) return;
    const lease = await findLeaseDocumentLease(req.params.id);
    if (!lease) return res.status(404).json({ error: 'Lease not found.' });

    const [{ data: rows, error: documentsError }, { data: access, error: accessError }] = await Promise.all([
      supabaseServiceRole
        .from('lease_documents')
        .select('id, original_name, mime_type, file_size, created_at, storage_path')
        .eq('lease_id', lease.id)
        .order('created_at', { ascending: false }),
      supabaseServiceRole
        .from('lease_document_access')
        .select('revoked_at')
        .eq('lease_id', lease.id)
        .maybeSingle(),
    ]);
    if (documentsError) throw documentsError;
    if (accessError) throw accessError;

    const documents = await Promise.all((rows || []).map(signLeaseDocument));
    return res.json({
      documents,
      access: {
        enabled: Boolean(access && !access.revoked_at),
        revokedAt: access?.revoked_at || null,
      },
    });
  } catch (error) {
    console.error('Lease documents list error:', error?.message || error);
    return res.status(500).json({
      error: 'Unable to load lease documents. Confirm the lease documents migration and private Storage bucket are configured.',
    });
  }
});

app.post(
  '/api/leases/:id/documents',
  requireRoles('Admin', 'Manager'),
  parseLeaseDocumentsMultipart,
  async (req, res) => {
    const uploadedPaths = [];
    let metadataSaved = false;
    try {
      if (!requireLeaseDocumentStorage(res)) return;
      if (!Array.isArray(req.files) || !req.files.length) {
        return res.status(400).json({ error: 'Choose at least one PDF, JPG, or PNG document.' });
      }

      const lease = await findLeaseDocumentLease(req.params.id);
      if (!lease) return res.status(404).json({ error: 'Lease not found.' });

      const validatedFiles = req.files.map((file) => {
        const detected = detectLeaseDocumentFormat(file.buffer);
        const claimedMime = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
        if (!detected || detected.mimeType !== claimedMime) {
          throw Object.assign(
            new Error('One or more files do not match their actual PDF, JPG, or PNG content.'),
            { statusCode: 400 }
          );
        }
        const originalName = cleanLeaseDocumentName(file.originalname);
        const originalExtension = originalName.includes('.')
          ? originalName.split('.').pop().toLowerCase()
          : '';
        const allowedExtensions = {
          'application/pdf': ['pdf'],
          'image/jpeg': ['jpg', 'jpeg'],
          'image/png': ['png'],
        };
        if (!allowedExtensions[detected.mimeType]?.includes(originalExtension)) {
          throw Object.assign(
            new Error('A lease document filename extension does not match its actual file type.'),
            { statusCode: 400 }
          );
        }
        return { file, detected, originalName };
      });

      const bucket = supabaseServiceRole.storage.from(LEASE_DOCUMENT_BUCKET);
      const rows = [];
      for (const { file, detected, originalName } of validatedFiles) {
        const storagePath = `${lease.id}/${crypto.randomUUID()}.${detected.extension}`;
        const { error: uploadError } = await bucket.upload(storagePath, file.buffer, {
          contentType: detected.mimeType,
          upsert: false,
        });
        if (uploadError) throw uploadError;
        uploadedPaths.push(storagePath);
        rows.push({
          id: crypto.randomUUID(),
          lease_id: lease.id,
          original_name: originalName,
          storage_path: storagePath,
          mime_type: detected.mimeType,
          file_size: file.size,
          created_by: req.auth.sub,
        });
      }

      const { error: insertError } = await supabaseServiceRole
        .from('lease_documents')
        .insert(rows);
      if (insertError) throw insertError;
      metadataSaved = true;

      return res.status(201).json({ success: true, uploaded: rows.length });
    } catch (error) {
      if (!metadataSaved && uploadedPaths.length) {
        try {
          const { error: cleanupError } = await supabaseServiceRole
            .storage.from(LEASE_DOCUMENT_BUCKET).remove(uploadedPaths);
          if (cleanupError) {
            console.error('Lease document upload cleanup failed:', cleanupError.message || cleanupError);
          }
        } catch (cleanupError) {
          console.error('Lease document upload cleanup failed:', cleanupError?.message || cleanupError);
        }
      }
      console.error('Lease document upload error:', error?.message || error);
      return res.status(error.statusCode || (error.code === 'LEASE_DOCUMENT_STORAGE_UNAVAILABLE' ? 503 : 500))
        .json({
          error: error.statusCode === 400
            ? error.message
            : 'Unable to save lease documents. Confirm the lease documents migration and private Storage bucket are configured.',
        });
    }
  }
);

app.post(
  '/api/leases/:id/documents/access',
  requireRoles('Admin', 'Manager', 'Accountant'),
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!requireLeaseDocumentStorage(res)) return;
      const lease = await findLeaseDocumentLease(req.params.id);
      if (!lease) return res.status(404).json({ error: 'Lease not found.' });

      const regenerate = req.body?.regenerate === true;
      if (regenerate && !['admin', 'manager'].includes(String(req.auth.role).toLowerCase())) {
        return res.status(403).json({ error: 'Only management can regenerate a lease document link.' });
      }

      const token = await createOrReadLeaseDocumentAccess(lease.id, {
        regenerate,
        allowCreate: ['admin', 'manager'].includes(String(req.auth.role).toLowerCase()),
        createdBy: req.auth.sub,
      });
      return res.set('Cache-Control', 'no-store').json({ token });
    } catch (error) {
      const status = error.code === 'LEASE_DOCUMENT_ACCESS_NOT_FOUND' ? 404 :
        error.code === 'LEASE_DOCUMENT_ACCESS_REVOKED' ? 409 :
        ['LEASE_DOCUMENT_TOKEN_KEY_MISMATCH', 'LEASE_DOCUMENT_TOKEN_SECRET_INVALID'].includes(error.code) ? 503 : 500;
      console.error('Lease document access setup error:', error?.message || error);
      return res.status(status).json({
        error: status === 404 || status === 409 || status === 503
          ? error.message
          : 'Unable to prepare the lease document link. Confirm the migration and lease document token secret configuration.',
      });
    }
  }
);

app.delete('/api/leases/:id/documents/access', requireRoles('Admin', 'Manager'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!requireLeaseDocumentStorage(res)) return;
    const lease = await findLeaseDocumentLease(req.params.id);
    if (!lease) return res.status(404).json({ error: 'Lease not found.' });

    const { data, error } = await supabaseServiceRole
      .from('lease_document_access')
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('lease_id', lease.id)
      .is('revoked_at', null)
      .select('lease_id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'No active lease document link was found.' });
    return res.json({ success: true });
  } catch (error) {
    console.error('Lease document access revoke error:', error?.message || error);
    return res.status(500).json({ error: 'Unable to revoke the lease document link.' });
  }
});

app.get('/api/leases/:id/security-deposits', requireRoles('Admin', 'Manager', 'Accountant'), async (req, res) => {
  try {
    const { getSecurityDepositSummary } = await import('./src/dataService.js');
    const summary = await getSecurityDepositSummary(req.params.id);
    res.json(summary);
  } catch (error) {
    const status = error.code === 'NOT_FOUND' ? 404 : 500;
    if (status === 500) console.error('Get security deposit summary error:', error.message || error);
    res.status(status).json({ error: status === 404 ? 'Lease not found.' : 'Unable to load security deposit records. Confirm the database migration has been applied.' });
  }
});

app.post('/api/leases/:id/security-deposits', requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    const { recordSecurityDepositTransaction } = await import('./src/dataService.js');
    const transaction = await recordSecurityDepositTransaction(
      req.params.id,
      req.body || {},
      req.auth.sub
    );
    res.status(201).json(transaction);
  } catch (error) {
    const status = error.code === 'NOT_FOUND' ? 404 :
      error.code === 'DEPOSIT_VALIDATION' ? 400 : 500;
    if (status === 500) console.error('Record security deposit transaction error:', error.message || error);
    res.status(status).json({
      error: status === 404 ? 'Lease not found.' :
        status === 400 ? error.message :
        'Unable to record the security deposit transaction. Confirm the database migration has been applied.'
    });
  }
});
app.post('/api/leases', requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    const item = await createLease({
      tenant_id: req.body.tenantId,
      unit_id: req.body.unitId,
      unit_number: Number(req.body.unitNumber ?? req.body.unit_number),
      start_date: req.body.startDate ?? req.body.start_date,
      end_date: req.body.endDate ?? req.body.end_date,
      monthly_rent: Number(req.body.monthlyRent ?? req.body.monthly_rent ?? 0),
      security_deposit: Number(req.body.securityDeposit ?? req.body.security_deposit ?? 0),
      status: req.body.status ?? 'Active',
      notes: req.body.notes ?? '',
    });
    res.status(201).json(item);
  } catch (error) {
    console.error('Create lease error:', error);
    const status = error.code === 'LEASE_VALIDATION' ? 400 : 500;
    res.status(status).json({ error: error.message || 'Unable to create lease.' });
  }
});

app.patch('/api/leases/:id', requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    const item = await updateLease(req.params.id, {
      tenant_id: req.body.tenantId,
      unit_id: req.body.unitId,
      unit_number: Number(req.body.unitNumber ?? req.body.unit_number),
      start_date: req.body.startDate ?? req.body.start_date,
      end_date: req.body.endDate ?? req.body.end_date,
      monthly_rent: Number(req.body.monthlyRent ?? req.body.monthly_rent ?? 0),
      security_deposit: Number(req.body.securityDeposit ?? req.body.security_deposit ?? 0),
      status: req.body.status ?? 'Active',
      notes: req.body.notes ?? '',
    });
    res.json(item);
  } catch (error) {
    console.error('Update lease error:', error);
    res.status(500).json({ error: error.message || 'Unable to update lease.' });
  }
});

app.delete('/api/leases/:id', requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    const item = await terminateLease(req.params.id, req.body?.notes || '');
    res.json(item);
  } catch (error) {
    console.error('Terminate lease error:', error);
    res.status(500).json({ error: error.message || 'Unable to terminate lease.' });
  }
});

app.post('/api/payments', requireRoles('Admin', 'Manager', 'Accountant'), async (req, res) => {
  try {
    const item = await createPayment({
      tenant_id: req.body.tenantId,
      unit_id: req.body.unitId,
      unit_number: Number(req.body.unitNumber ?? req.body.unit_number),
      amount: Number(req.body.amount ?? 0),
      paidAmount: Number(req.body.paidAmount ?? req.body.paid_amount ?? 0),
      due_date: req.body.dueDate ?? req.body.due_date,
      paid_date: req.body.paidDate ?? req.body.paid_date ?? null,
      status: req.body.status ?? 'Outstanding',
      method: req.body.method ?? 'Unknown',
      notes: req.body.notes ?? '',
    });
    res.status(201).json(item);
  } catch (error) {
    console.error('Create payment error:', error);
    res.status(error.code === 'TENANT_ASSIGNMENT_VALIDATION' || error.code === 'PAYMENT_VALIDATION' ? 400 : 500).json({
      error: error.code === 'TENANT_ASSIGNMENT_VALIDATION' || error.code === 'PAYMENT_VALIDATION'
        ? error.message
        : 'Unable to record payment.',
    });
  }
});

app.patch('/api/payments/:id', requireRoles('Admin', 'Manager', 'Accountant'), async (req, res) => {
  try {
    const item = await updatePayment(req.params.id, {
      tenant_id: req.body.tenantId,
      unit_id: req.body.unitId,
      unit_number: Number(req.body.unitNumber ?? req.body.unit_number),
      amount: Number(req.body.amount ?? 0),
      paidAmount: Number(req.body.paidAmount ?? req.body.paid_amount ?? 0),
      due_date: req.body.dueDate ?? req.body.due_date,
      paid_date: req.body.paidDate ?? req.body.paid_date ?? null,
      status: req.body.status,
      method: req.body.method,
      notes: req.body.notes ?? '',
    });
    res.json(item);
  } catch (error) {
    console.error('Update payment error:', error);
    res.status(error.code === 'TENANT_ASSIGNMENT_VALIDATION' || error.code === 'PAYMENT_VALIDATION' ? 400 : 500).json({
      error: error.code === 'TENANT_ASSIGNMENT_VALIDATION' || error.code === 'PAYMENT_VALIDATION'
        ? error.message
        : 'Unable to update payment.',
    });
  }
});

app.delete('/api/payments/:id', requireRoles('Admin', 'Manager', 'Accountant'), async (req, res) => {
  try {
    await deleteEntity('payments', req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete payment error:', error);
    res.status(500).json({ error: 'Unable to delete payment.' });
  }
});

// Tenant QR: submit a payment notification for manager review.
app.post(
  '/api/public/qr/:unitNumber/payment-notification',
  requireTenantQrSession,
  async (req, res) => {
    try {
      const result = await submitTenantPaymentNotification({
        access: req.tenantQrAccess,
        requestedUnitNumber: req.params.unitNumber,
        body: req.body,
        idempotencyKey:
          req.get('Idempotency-Key') ||
          req.body?.idempotencyKey ||
          crypto.randomUUID(),
      });

      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error('Submit payment notification error:', error);
      return res.status(500).json({
        error: 'Unable to submit the payment notification.',
      });
    }
  }
);

// Manager: list tenant payment notifications.
app.get(
  '/api/manager/payment-notifications',
  requireRoles('Admin', 'Manager'),
  async (req, res) => {
    try {
      const notifications = await listManagerPaymentNotifications();
      return res.json(notifications);
    } catch (error) {
      console.error('List payment notifications error:', error);
      return res.status(500).json({
        error: 'Unable to load payment notifications.',
      });
    }
  }
);

// Manager: review a tenant payment notification.
app.patch(
  '/api/manager/payment-notifications/:id',
  requireRoles('Admin', 'Manager'),
  async (req, res) => {
    try {
      const result = await reviewPaymentNotification({
        notificationId: req.params.id,
        action: req.body?.action,
        reviewNote: req.body?.reviewNote,
        reviewedBy: req.auth.sub,
      });

      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error('Review payment notification error:', error);
      return res.status(500).json({
        error: 'Unable to review the payment notification.',
      });
    }
  }
);
// Tenant QR: submit a move-out request for manager review.
app.post(
  '/api/public/qr/:unitNumber/move-out-request',
  requireTenantQrSession,
  async (req, res) => {
    try {
      const result = await submitTenantMoveOutRequest({
        access: req.tenantQrAccess,
        requestedUnitNumber: req.params.unitNumber,
        body: req.body,
      });

      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error('Submit move-out request error:', error);
      return res.status(500).json({
        error: 'Unable to submit the move-out request.',
      });
    }
  }
);

// Manager: list tenant move-out requests.
app.get(
  '/api/manager/move-out-requests',
  requireRoles('Admin', 'Manager'),
  async (req, res) => {
    try {
      const result = await listManagerMoveOutRequests();
      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error('List move-out requests error:', error);
      return res.status(500).json({
        error: 'Unable to load move-out requests.',
      });
    }
  }
);

// Manager: approve or reject a move-out request without terminating its lease.
app.patch(
  '/api/manager/move-out-requests/:id',
  requireRoles('Admin', 'Manager'),
  async (req, res) => {
    try {
      const result = await reviewMoveOutRequest({
        requestId: req.params.id,
        action: req.body?.action,
        reviewNote: req.body?.reviewNote,
        reviewedBy: req.auth.sub,
      });

      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error('Review move-out request error:', error);
      return res.status(500).json({
        error: 'Unable to review the move-out request.',
      });
    }
  }
);
app.post('/api/manager/leases/:leaseId/tenant-pin', requireRoles('Admin', 'Manager'), generateTenantPin);

app.post('/api/public/qr/:unitNumber/verify-pin', verifyTenantPin);
app.post('/api/public/qr/:unitNumber/maintenance', requireTenantQrSession, parseQrMaintenanceMultipart, async (req, res) => {
  let item = null;
  let hasQrMedia = false;
  const uploadedStoragePaths = [];

  try {
    const unitNumber = Number(req.params.unitNumber);
    const { title, description, priority } = req.body || {};
    const mediaFiles = ['audio', 'photo', 'video'].flatMap((field) => req.files?.[field] || []);
    hasQrMedia = mediaFiles.length > 0;

    if (!Number.isInteger(unitNumber) || unitNumber <= 0) {
      return res.status(400).json({ error: 'Invalid unit number.' });
    }

    const units = await getUnits();
    const unit = units.find(
      (item) => Number(item.unitNumber ?? item.unit_number) === unitNumber
    );

    if (!unit) {
      return res.status(404).json({ error: 'Unit not found.' });
    }

    const cleanTitle = String(title ?? '').trim();
    const cleanDescription = String(description ?? '').trim();
    const allowedPriorities = ['Low', 'Medium', 'High', 'Emergency'];
    const cleanPriority = allowedPriorities.includes(String(priority))
      ? priority
      : 'Medium';

    if (!cleanTitle && !cleanDescription && !mediaFiles.length) {
      return res.status(400).json({
        error: 'Describe the problem or attach a voice recording, photo, or video.'
      });
    }

    if (cleanTitle.length > 200) {
      return res.status(400).json({
        error: 'Maintenance title is too long.'
      });
    }

    if (cleanDescription.length > 5000) {
      return res.status(400).json({
        error: 'Maintenance description is too long.'
      });
    }

    for (const file of mediaFiles) {
      const maximumSize = QR_MEDIA_LIMITS[file.fieldname];
      if (file.size > maximumSize) {
        return res.status(413).json({
          error: `${file.fieldname} exceeds the ${maximumSize / (1024 * 1024)} MB file limit.`,
        });
      }
    }

    if (mediaFiles.length && !supabaseServiceRole) {
      return res.status(503).json({ error: 'Media uploads are unavailable right now. Please submit a text-only request or try again later.' });
    }

    const maintenancePayload = {
      property_id: unit.propertyId ?? unit.property_id ?? null,
      tenant_id: req.tenantQrAccess.tenantId,
      unit_id: unit.id ?? null,
      unit_number: unitNumber,
      title: cleanTitle || 'Maintenance request',
      description: cleanDescription,
      priority: cleanPriority,
      status: 'Pending',
      assigned_technician: '',
      request_date: new Date().toISOString().slice(0, 10),
      due_date: null,
      completion_date: null,
      reminder_at: null,
      notes: 'Submitted through the Riiroow unit QR service.',
      created_at: new Date().toISOString(),
    };

    if (mediaFiles.length) {
      const { data, error } = await supabaseServiceRole
        .from('maintenance_requests')
        .insert([{ ...maintenancePayload, id: crypto.randomUUID() }])
        .select()
        .single();
      if (error) throw error;
      item = data;

      const evidenceRows = [];
      for (const file of mediaFiles) {
        const mimeType = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
        const extension = QR_MEDIA_EXTENSIONS[mimeType] || 'bin';
        const storagePath = `${item.id}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await supabaseServiceRole.storage
          .from(QR_MEDIA_BUCKET)
          .upload(storagePath, file.buffer, { contentType: mimeType, upsert: false });
        if (uploadError) throw uploadError;

        uploadedStoragePaths.push(storagePath);
        const originalName = String(file.originalname || 'upload')
          .replace(/\\/g, '/')
          .split('/')
          .pop()
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .slice(0, 255) || 'upload';
        evidenceRows.push({
          maintenance_request_id: item.id,
          file_type: file.fieldname,
          storage_path: storagePath,
          original_name: originalName,
          mime_type: mimeType,
          file_size: file.size,
        });
      }

      const { error: evidenceError } = await supabaseServiceRole.from('maintenance_evidence').insert(evidenceRows);
      if (evidenceError) throw evidenceError;
    } else {
      item = await createEntity('maintenance_requests', maintenancePayload);
    }

    res.status(201).json({
      success: true,
      requestId: item.id,
      unitNumber,
      status: item.status ?? 'Pending',
      message: 'Maintenance request submitted successfully.'
    });
  } catch (error) {
    console.error('Public QR maintenance error:', error);

    if (item && hasQrMedia && supabaseServiceRole) {
      let cleanupSucceeded = true;
      try {
        const { error: evidenceDeleteError } = await supabaseServiceRole
          .from('maintenance_evidence')
          .delete()
          .eq('maintenance_request_id', item.id);
        if (evidenceDeleteError) {
          cleanupSucceeded = false;
          console.error('Public QR evidence cleanup error:', evidenceDeleteError);
        }

        if (uploadedStoragePaths.length) {
          const { error: storageDeleteError } = await supabaseServiceRole.storage
            .from(QR_MEDIA_BUCKET)
            .remove(uploadedStoragePaths);
          if (storageDeleteError) {
            cleanupSucceeded = false;
            console.error('Public QR storage cleanup error:', storageDeleteError);
          }
        }

        const { error: requestDeleteError } = await supabaseServiceRole
          .from('maintenance_requests')
          .delete()
          .eq('id', item.id);
        if (requestDeleteError) {
          cleanupSucceeded = false;
          console.error('Public QR request cleanup error:', requestDeleteError);
        }
      } catch (cleanupError) {
        cleanupSucceeded = false;
        console.error('Public QR cleanup error:', cleanupError);
      }

      return res.status(500).json({
        error: cleanupSucceeded
          ? 'Media upload failed. The maintenance request was not saved. Please try again.'
          : 'Media upload failed and cleanup could not be confirmed. Please contact management before submitting again.',
      });
    }

    res.status(500).json({
      error: 'Unable to submit maintenance request.'
    });
  }
});

app.get('/api/maintenance/:id/evidence', requireRoles('Admin', 'Manager', 'Maintenance'), async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    if (!supabaseServiceRole) {
      return res.status(503).json({ error: 'Maintenance evidence storage is not configured on the server.' });
    }

    const { data: request, error: requestError } = await supabaseServiceRole
      .from('maintenance_requests')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (requestError) throw requestError;
    if (!request) return res.status(404).json({ error: 'Maintenance request not found.' });

    const { data: rows, error: evidenceError } = await supabaseServiceRole
      .from('maintenance_evidence')
      .select('id, file_type, original_name, mime_type, file_size, storage_path')
      .eq('maintenance_request_id', request.id);

    if (evidenceError) throw evidenceError;

    const evidence = await Promise.all((rows || []).map(async (row) => {
      const bucket = supabaseServiceRole.storage.from(QR_MEDIA_BUCKET);
      const [
        { data: previewData, error: previewError },
        { data: downloadData, error: downloadError },
      ] = await Promise.all([
        bucket.createSignedUrl(row.storage_path, 600),
        bucket.createSignedUrl(row.storage_path, 600, { download: row.original_name }),
      ]);

      if (previewError) throw previewError;
      if (downloadError) throw downloadError;

      return {
        id: row.id,
        fileType: row.file_type,
        originalName: row.original_name,
        mimeType: row.mime_type,
        fileSize: row.file_size,
        url: previewData.signedUrl,
        downloadUrl: downloadData.signedUrl,
      };
    }));

    return res.json({ evidence });
  } catch (error) {
    console.error('Maintenance evidence fetch error:', error);
    return res.status(500).json({ error: 'Unable to load maintenance attachments.' });
  }
});
app.post('/api/maintenance', requireRoles('Admin', 'Manager', 'Maintenance'), async (req, res) => {
  try {
    const item = await createEntity('maintenance_requests', {
      tenant_id: req.body.tenantId,
      unit_id: req.body.unitId,
      unit_number: Number(req.body.unitNumber ?? req.body.unit_number),
      title: req.body.title,
      description: req.body.description || '',
      priority: req.body.priority ?? 'Medium',
      status: req.body.status ?? 'Pending',
      assigned_technician: req.body.assignedTechnician ?? req.body.assigned_technician ?? '',
      request_date: req.body.requestDate ?? req.body.request_date ?? null,
      due_date: req.body.dueDate ?? req.body.due_date ?? null,
      completion_date: req.body.completionDate ?? req.body.completion_date ?? null,
      reminder_at: req.body.reminderAt ?? req.body.reminder_at ?? null,
      notes: req.body.notes ?? '',
      created_at: req.body.createdAt ?? req.body.created_at ?? new Date().toISOString(),
    });
    res.status(201).json(item);
  } catch (error) {
    console.error('Create maintenance error:', error);
    res.status(500).json({ error: 'Unable to create maintenance request.' });
  }
});

app.patch('/api/maintenance/:id', requireRoles('Admin', 'Manager', 'Maintenance'), async (req, res) => {
  try {
    const item = await updateEntity('maintenance_requests', req.params.id, {
      tenant_id: req.body.tenantId,
      unit_id: req.body.unitId,
      unit_number: Number(req.body.unitNumber ?? req.body.unit_number),
      title: req.body.title,
      description: req.body.description || '',
      priority: req.body.priority,
      status: req.body.status,
      assigned_technician: req.body.assignedTechnician ?? req.body.assigned_technician ?? '',
      request_date: req.body.requestDate ?? req.body.request_date ?? null,
      due_date: req.body.dueDate ?? req.body.due_date ?? null,
      completion_date: req.body.completionDate ?? req.body.completion_date ?? null,
      reminder_at: req.body.reminderAt ?? req.body.reminder_at ?? null,
      notes: req.body.notes ?? '',
    });
    res.json(item);
  } catch (error) {
    console.error('Update maintenance error:', error);
    res.status(500).json({ error: 'Unable to update maintenance request.' });
  }
});

app.delete('/api/maintenance/:id', requireRoles('Admin', 'Manager', 'Maintenance'), async (req, res) => {
  try {
    await deleteEntity('maintenance_requests', req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete maintenance error:', error);
    res.status(500).json({ error: 'Unable to delete maintenance request.' });
  }
});

app.patch('/api/units/:id', requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    const item = await updateEntity('units', req.params.id, {
      unit_number: Number(req.body.unitNumber ?? req.body.unit_number),
      floor: Number(req.body.floor),
      bedrooms: Number(req.body.bedrooms ?? 1),
      bathrooms: Number(req.body.bathrooms ?? 1),
      rent: Number(req.body.rent ?? 0),
      status: req.body.status,
      occupancy: req.body.occupancy,
      last_payment_date: req.body.lastPaymentDate ?? req.body.last_payment_date,
    });
    res.json(item);
  } catch (error) {
    console.error('Update unit error:', error);
    res.status(500).json({ error: 'Unable to update unit.' });
  }
});

app.delete('/api/units/:id', requireRoles('Admin'), async (req, res) => {
  try {
    await deleteEntity('units', req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete unit error:', error);
    res.status(500).json({ error: 'Unable to delete unit.' });
  }
});

app.get(['/signature.png', '/riiroow-apartments/signature.png'], (req, res, next) => {
  res.sendFile(path.resolve(__dirname, '../frontend/public/signature.png'), (error) => {
    if (error) next(error);
  });
});
app.use(express.static(frontendDist));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  return res.sendFile(path.join(frontendDist, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

export { app };

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  app.listen(port, () => {
    console.log(`Riiroow API is running on http://localhost:${port}`);
  });
}
