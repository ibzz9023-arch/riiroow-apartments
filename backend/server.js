import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import {
  createEntity,
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
  updatePayment,
  updateTenant,
} from './src/dataService.js';
import { hasSupabase } from './src/supabaseClient.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const app = express();
const port = Number(process.env.PORT || 5000);

app.use(cors());
app.use(express.json());

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

app.post('/api/auth/login', async (req, res) => {
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

app.post('/api/leases', requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    const item = await createEntity('leases', {
      tenant_id: req.body.tenantId,
      unit_id: req.body.unitId,
      unit_number: Number(req.body.unitNumber ?? req.body.unit_number),
      start_date: req.body.startDate ?? req.body.start_date,
      end_date: req.body.endDate ?? req.body.end_date,
      monthly_rent: Number(req.body.monthlyRent ?? req.body.monthly_rent ?? 0),
      status: req.body.status ?? 'Active',
    });
    res.status(201).json(item);
  } catch (error) {
    console.error('Create lease error:', error);
    res.status(500).json({ error: 'Unable to create lease.' });
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

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(port, () => {
  console.log(`Riiroow API is running on http://localhost:${port}`);
});
