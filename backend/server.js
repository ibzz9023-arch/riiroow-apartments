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
  getUnits,
  getUsers,
  loginUser,
  updateEntity,
  updateLease,
  updatePayment,
  updateTenant,
  terminateLease,
  toLegacyUser,
} from './src/dataService.js';
import { hasSupabase, supabase, supabaseServiceRole } from './src/supabaseClient.js';

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
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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

const authHeaderToRole = (req) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.replace('Bearer ', '').trim();
  if (token.startsWith('demo-token-')) {
    return token.replace('demo-token-', '').trim();
  }
  return null;
};

const normalizeRole = (role) => String(role || '').trim();

const requireRoles = (...roles) => (req, res, next) => {
  const userRole = normalizeRole(authHeaderToRole(req));
  if (!userRole) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const allowedRoles = roles.map((role) => normalizeRole(role).toLowerCase());
  if (!allowedRoles.includes(userRole.toLowerCase())) {
    return res.status(403).json({ error: 'You do not have access to this resource.' });
  }

  next();
};

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
  try {
    const { email, password } = req.body || {};
    const loginResult = await loginUser({ email, password });

    if (!loginResult) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    return res.json(loginResult);
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Unable to complete login.' });
  }
});

app.get('/api/users', requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    res.json(await getUsers());
  } catch (error) {
    console.error('Users fetch error:', error);
    res.status(500).json({ error: 'Unable to load users.' });
  }
});

app.get('/api/dashboard', requireRoles('Admin', 'Manager', 'Maintenance', 'Accountant'), async (req, res) => {
  try {
    res.json(await getDashboard());
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
    res.json(await getTenants());
  } catch (error) {
    console.error('Tenants fetch error:', error);
    res.status(500).json({ error: 'Unable to load tenants.' });
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
    console.error('Delete tenant error:', error);
    res.status(500).json({ error: 'Unable to delete tenant.' });
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
      null
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
        reviewedBy: null,
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
        reviewedBy: null,
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
      const { data, error } = await supabaseServiceRole.storage
        .from(QR_MEDIA_BUCKET)
        .createSignedUrl(row.storage_path, 600);

      if (error) throw error;

      return {
        id: row.id,
        fileType: row.file_type,
        originalName: row.original_name,
        mimeType: row.mime_type,
        fileSize: row.file_size,
        url: data.signedUrl,
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

app.listen(port, () => {
  console.log(`Riiroow API is running on http://localhost:${port}`);
});
