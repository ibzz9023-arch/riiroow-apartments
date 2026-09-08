import crypto from 'node:crypto';
import { supabase, hasSupabase } from './supabaseClient.js';
import { loadData, saveData, seedState, summarizeDashboard, calculatePaymentStatus } from './store.js';

const propertyName = 'Riiroow Apartments';
const validUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const normalizeRoleValue = (value) => String(value || '').trim();
const assignmentError = (message) => Object.assign(new Error(message), { code: 'TENANT_ASSIGNMENT_VALIDATION' });
const hashPassword = (value) =>
  crypto.pbkdf2Sync(String(value ?? ''), 'riiroow-apartments-v1', 100000, 64, 'sha512').toString('hex');
const passwordMatches = (storedPassword, candidatePassword) => {
  const stored = String(storedPassword ?? '');
  const candidate = String(candidatePassword ?? '');

  if (!stored || !candidate) {
    return false;
  }

  return stored === candidate || stored === hashPassword(candidate) || hashPassword(stored) === hashPassword(candidate);
};

const createUuidIfNeeded = (value) => {
  if (!value || validUuidPattern.test(String(value))) {
    return value || crypto.randomUUID();
  }

  const seed = Array.from(String(value)).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return crypto.randomUUID().replace(/^[0-9a-f]{8}/, seed.toString(16).padStart(8, '0').slice(0, 8));
};

const toLegacyUnit = (row = {}) => ({
  id: row.id,
  unitNumber: row.unit_number ?? row.unitNumber,
  floor: row.floor ?? 1,
  bedrooms: row.bedrooms ?? 1,
  rent: Number(row.rent ?? 0),
  status: row.status ?? 'vacant',
  tenantId: row.tenant_id ?? row.tenantId ?? null,
  leaseId: row.lease_id ?? row.leaseId ?? null,
  lastPaymentDate: row.last_payment_date ?? row.lastPaymentDate ?? null,
  occupancy: row.occupancy ?? (row.status === 'occupied' ? 'Occupied' : 'Vacant'),
});

const toLegacyTenant = (row = {}) => ({
  id: row.id,
  name: row.name,
  unitId: row.unit_id ?? row.unitId ?? null,
  unitNumber: row.unit_number ?? row.unitNumber,
  email: row.email,
  phone: row.phone,
  moveInDate: row.move_in_date ?? row.moveInDate,
  status: row.status ?? 'Active',
});

const toLegacyLease = (row = {}) => ({
  id: row.id,
  tenantId: row.tenant_id ?? row.tenantId,
  unitNumber: row.unit_number ?? row.unitNumber,
  startDate: row.start_date ?? row.startDate,
  endDate: row.end_date ?? row.endDate,
  monthlyRent: Number(row.monthly_rent ?? row.monthlyRent ?? 0),
  status: row.status ?? 'Active',
});

const toLegacyPayment = (row = {}) => {
  const payment = {
    id: row.id,
    tenantId: row.tenant_id ?? row.tenantId,
    unitId: row.unit_id ?? row.unitId ?? null,
    unitNumber: row.unit_number ?? row.unitNumber,
    amount: Number(row.amount ?? 0),
    dueDate: row.due_date ?? row.dueDate,
    paidDate: row.paid_date ?? row.paidDate ?? null,
    status: calculatePaymentStatus(row),
    method: row.method ?? 'Unknown',
    notes: row.notes ?? '',
  };

  return payment;
};

const toLegacyMaintenance = (row = {}) => ({
  id: row.id,
  unitNumber: row.unit_number ?? row.unitNumber,
  title: row.title,
  description: row.description,
  status: row.status ?? 'Pending',
  priority: row.priority ?? 'Medium',
  assignedTechnician: row.assigned_technician ?? row.assignedTechnician ?? '',
  requestDate: row.request_date ?? row.requestDate ?? (row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : null),
  dueDate: row.due_date ?? row.dueDate ?? null,
  completionDate: row.completion_date ?? row.completionDate ?? null,
  reminderAt: row.reminder_at ?? row.reminderAt ?? null,
  notes: row.notes ?? '',
  createdAt: row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : null,
});

const summarizeTenantPayments = (payments) => {
  const normalizedPayments = (payments || []).map((payment) => ({
    ...payment,
    status: calculatePaymentStatus(payment),
  }));

  return normalizedPayments.reduce((totals, payment) => {
    const amount = Number(payment.amount || 0);
    if (payment.status === 'Paid') totals.totalPaid += amount;
    if (payment.status === 'Outstanding') totals.totalOutstanding += amount;
    if (payment.status === 'Overdue') totals.totalOverdue += amount;
    return totals;
  }, { totalPaid: 0, totalOutstanding: 0, totalOverdue: 0 });
};

const toLegacyUser = (row = {}) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  password: row.password,
  role: normalizeRoleValue(row.role),
  permissions: Array.isArray(row.permissions) ? row.permissions : [],
});

const ensureProperty = async () => {
  if (!supabase) return null;

  const { data: existingProperty, error: propertyError } = await supabase
    .from('properties')
    .select('id')
    .eq('name', propertyName)
    .maybeSingle();

  if (propertyError) {
    throw propertyError;
  }

  if (existingProperty) {
    return existingProperty.id;
  }

  const { data: createdProperty, error: createError } = await supabase
    .from('properties')
    .insert([
      {
        name: propertyName,
        address: '1250 North Residence Blvd',
        city: 'Dallas',
        state: 'TX',
        zip_code: '75204',
        floors: 5,
      },
    ])
    .select('id')
    .single();

  if (createError) {
    throw createError;
  }

  return createdProperty.id;
};

const upsertSeedData = async () => {
  if (!supabase) return;

  const propertyId = await ensureProperty();
  if (!propertyId) return;

  const seeded = seedState();
  const seededUnitIds = Object.fromEntries(seeded.units.map((unit, index) => [unit.unitNumber, crypto.randomUUID()]));
  const seededTenantIds = Object.fromEntries(seeded.tenants.map((tenant) => [tenant.unitNumber, crypto.randomUUID()]));
  const seededLeaseIds = Object.fromEntries(seeded.leases.map((lease) => [lease.unitNumber, crypto.randomUUID()]));
  const seededPaymentIds = Object.fromEntries(seeded.payments.map((payment) => [payment.unitNumber, crypto.randomUUID()]));
  const seededMaintenanceIds = Object.fromEntries(seeded.maintenance.map((entry) => [entry.unitNumber, crypto.randomUUID()]));

  const unitRows = seeded.units.map((unit) => ({
    id: seededUnitIds[unit.unitNumber],
    property_id: propertyId,
    unit_number: Number(unit.unitNumber),
    floor: Number(unit.floor),
    bedrooms: Number(unit.bedrooms),
    bathrooms: 2,
    rent: Number(unit.rent),
    status: unit.status,
    occupancy: unit.occupancy,
    last_payment_date: unit.lastPaymentDate,
  }));

  const tenantRows = seeded.tenants.map((tenant) => ({
    id: seededTenantIds[tenant.unitNumber],
    property_id: propertyId,
    name: tenant.name,
    email: tenant.email,
    phone: tenant.phone,
    unit_number: Number(tenant.unitNumber),
    move_in_date: tenant.moveInDate,
    status: tenant.status,
  }));

  const leaseRows = seeded.leases.map((lease) => ({
    id: seededLeaseIds[lease.unitNumber],
    property_id: propertyId,
    tenant_id: seededTenantIds[lease.unitNumber],
    unit_id: seededUnitIds[lease.unitNumber],
    unit_number: Number(lease.unitNumber),
    start_date: lease.startDate,
    end_date: lease.endDate,
    monthly_rent: Number(lease.monthlyRent),
    status: lease.status,
  }));

  const paymentRows = seeded.payments.map((payment) => ({
    id: seededPaymentIds[payment.unitNumber],
    property_id: propertyId,
    tenant_id: seededTenantIds[payment.unitNumber],
    unit_id: seededUnitIds[payment.unitNumber],
    unit_number: Number(payment.unitNumber),
    amount: Number(payment.amount),
    due_date: payment.dueDate,
    paid_date: payment.paidDate,
    status: payment.status,
    method: payment.method,
  }));

  const maintenanceRows = seeded.maintenance.map((entry) => ({
    id: seededMaintenanceIds[entry.unitNumber],
    property_id: propertyId,
    tenant_id: seededTenantIds[entry.unitNumber],
    unit_id: seededUnitIds[entry.unitNumber],
    unit_number: Number(entry.unitNumber),
    title: entry.title,
    description: entry.description,
    priority: entry.priority,
    status: entry.status,
  }));

  const userRows = seeded.users.map((user) => ({
    id: crypto.randomUUID(),
    name: user.name,
    email: user.email,
    password: user.password,
    role: user.role,
    permissions: user.permissions,
    is_active: true,
  }));

  await supabase.from('units').upsert(unitRows, { onConflict: 'id' });
  await supabase.from('tenants').upsert(tenantRows, { onConflict: 'id' });
  await supabase.from('leases').upsert(leaseRows, { onConflict: 'id' });
  await supabase.from('payments').upsert(paymentRows, { onConflict: 'id' });
  await supabase.from('maintenance_requests').upsert(maintenanceRows, { onConflict: 'id' });
  await supabase.from('users').upsert(userRows, { onConflict: 'email' });
};

const ensureSupabaseDataExists = async () => {
  if (!supabase) return;

  const [{ data: units }, { data: tenants }, { data: users }] = await Promise.all([
    supabase.from('units').select('id').limit(1),
    supabase.from('tenants').select('id').limit(1),
    supabase.from('users').select('id').limit(1),
  ]);

  if ((!units || units.length === 0) || (!tenants || tenants.length === 0) || (!users || users.length === 0)) {
    await upsertSeedData();
  }
};

export const getDashboard = async () => {
  if (supabase) {
    try {
      await ensureSupabaseDataExists();

      const [unitsResult, tenantsResult, leasesResult, paymentsResult, maintenanceResult] = await Promise.all([
        supabase.from('units').select('*').order('unit_number', { ascending: true }),
        supabase.from('tenants').select('*').order('name', { ascending: true }),
        supabase.from('leases').select('*').order('start_date', { ascending: false }),
        supabase.from('payments').select('*').order('due_date', { ascending: false }),
        supabase.from('maintenance_requests').select('*').order('created_at', { ascending: false }),
      ]);

      const units = (unitsResult.data || []).map(toLegacyUnit);
      const tenants = (tenantsResult.data || []).map(toLegacyTenant);
      const leases = (leasesResult.data || []).map(toLegacyLease);
      const payments = (paymentsResult.data || []).map(toLegacyPayment);
      const maintenance = (maintenanceResult.data || []).map(toLegacyMaintenance);

      const totalUnits = units.length;
      const occupiedUnits = units.filter((unit) => unit.status === 'occupied').length;
      const vacantUnits = totalUnits - occupiedUnits;
      const totalMonthlyRent = units.reduce((sum, unit) => sum + Number(unit.rent || 0), 0);
      const totalPaid = payments.filter((payment) => payment.status === 'Paid').reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      const totalOutstanding = payments.filter((payment) => payment.status === 'Outstanding').reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      const totalOverdue = payments.filter((payment) => payment.status === 'Overdue').reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      const openMaintenance = maintenance.filter((item) => item.status !== 'Resolved').length;

      return {
        stats: {
          totalUnits,
          occupiedUnits,
          vacantUnits,
          totalMonthlyRent,
          paidPayments: totalPaid,
          totalOutstanding,
          totalOverdue,
          overduePayments: totalOutstanding + totalOverdue,
          openMaintenance,
          occupancyRate: totalUnits ? Math.round((occupiedUnits / totalUnits) * 100) : 0,
        },
        units,
        tenants,
        leases,
        payments,
        maintenance,
      };
    } catch (error) {
      console.warn('Supabase dashboard query failed, using local fallback data.', error?.message || error);
    }
  }

  const state = loadData();
  return {
    ...summarizeDashboard(state),
    units: state.units.map(toLegacyUnit),
  };
};

export const getUnits = async () => {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('units').select('*').order('unit_number', { ascending: true });
      if (error) throw error;
      return (data || []).map(toLegacyUnit);
    } catch (error) {
      console.warn('Supabase units query failed, using local fallback data.', error?.message || error);
    }
  }

  return loadData().units.map(toLegacyUnit);
};

export const getTenants = async () => {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('tenants').select('*').order('name', { ascending: true });
      if (error) throw error;
      return (data || []).map(toLegacyTenant);
    } catch (error) {
      console.warn('Supabase tenants query failed, using local fallback data.', error?.message || error);
    }
  }

  return loadData().tenants.map(toLegacyTenant);
};

export const getTenantPayments = async (tenantId) => {
  if (supabase) {
    try {
      const propertyId = await ensureProperty();
      const { data: tenant, error: tenantError } = await supabase
        .from('tenants')
        .select('id, name')
        .eq('id', tenantId)
        .eq('property_id', propertyId)
        .maybeSingle();
      if (tenantError) throw tenantError;
      if (!tenant) return null;

      const { data, error } = await supabase
        .from('payments')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('property_id', propertyId)
        .order('due_date', { ascending: false });
      if (error) throw error;
      const payments = (data || []).map(toLegacyPayment);
      return { tenant, payments, totals: summarizeTenantPayments(payments) };
    } catch (error) {
      console.warn('Supabase tenant payments query failed, using local fallback data.', error?.message || error);
    }
  }

  const state = loadData();
  const tenant = (state.tenants || []).find((entry) => String(entry.id) === String(tenantId));
  if (!tenant) return null;
  const payments = (state.payments || [])
    .filter((entry) => String(entry.tenant_id ?? entry.tenantId) === String(tenantId))
    .map(toLegacyPayment)
    .sort((first, second) => String(second.dueDate || '').localeCompare(String(first.dueDate || '')));
  return { tenant: toLegacyTenant(tenant), payments, totals: summarizeTenantPayments(payments) };
};

export const getLeases = async () => {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('leases').select('*').order('start_date', { ascending: false });
      if (error) throw error;
      return (data || []).map(toLegacyLease);
    } catch (error) {
      console.warn('Supabase leases query failed, using local fallback data.', error?.message || error);
    }
  }

  return loadData().leases;
};

export const getPayments = async () => {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('payments').select('*').order('due_date', { ascending: false });
      if (error) throw error;
      return (data || []).map(toLegacyPayment);
    } catch (error) {
      console.warn('Supabase payments query failed, using local fallback data.', error?.message || error);
    }
  }

  return (loadData().payments || []).map(toLegacyPayment);
};

export const getMaintenance = async () => {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('maintenance_requests').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(toLegacyMaintenance);
    } catch (error) {
      console.warn('Supabase maintenance query failed, using local fallback data.', error?.message || error);
    }
  }

  return loadData().maintenance;
};

export const getUsers = async () => {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('users').select('*');
      if (error) throw error;
      return (data || []).map(toLegacyUser);
    } catch (error) {
      console.warn('Supabase users query failed, using local fallback data.', error?.message || error);
    }
  }

  return loadData().users;
};

export const loginUser = async ({ email, password }) => {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('email', String(email).toLowerCase())
        .limit(20);

      if (error) throw error;

      const matchingUser = (data || []).find((entry) => passwordMatches(entry.password, password));
      if (!matchingUser) {
        return null;
      }

      const user = toLegacyUser(matchingUser);
      const { password: _password, ...safeUser } = user;
      return {
        user: safeUser,
        token: `demo-token-${safeUser.role}`,
        permissions: safeUser.permissions,
      };
    } catch (error) {
      console.warn('Supabase login failed, using local fallback auth.', error?.message || error);
    }
  }

  const state = loadData();
  const user = state.users.find(
    (entry) => entry.email.toLowerCase() === String(email || '').toLowerCase() && passwordMatches(entry.password, password)
  );

  if (!user) {
    return null;
  }

  const { password: _password, ...safeUser } = user;
  return {
    user: safeUser,
    token: `demo-token-${safeUser.role}`,
    permissions: safeUser.permissions,
  };
};

const resolveLocalUnit = (state, unitId, unitNumber) => {
  const normalizedUnitNumber = Number(unitNumber);
  const unit = (state.units || []).find((entry) => (
    (unitId && String(entry.id) === String(unitId))
    || (!unitId && Number(entry.unit_number ?? entry.unitNumber) === normalizedUnitNumber)
  ));

  if (!unit) {
    throw assignmentError('Selected unit does not exist.');
  }

  return unit;
};

const hasOtherActiveLocalTenant = (state, unit, tenantId) => (state.tenants || []).some((tenant) => (
  tenant.id !== tenantId
  && tenant.status === 'Active'
  && ((tenant.unit_id && String(tenant.unit_id) === String(unit.id))
    || (!tenant.unit_id && Number(tenant.unit_number ?? tenant.unitNumber) === Number(unit.unit_number ?? unit.unitNumber)))
));

const synchronizeLocalUnit = (unit, tenantId, isActive) => {
  unit.status = isActive ? 'occupied' : 'vacant';
  unit.occupancy = isActive ? 'Occupied' : 'Vacant';
  unit.tenant_id = isActive ? tenantId : null;
};

const getSupabaseUnit = async (propertyId, unitId, unitNumber) => {
  let query = supabase.from('units').select('*').eq('property_id', propertyId);
  query = unitId ? query.eq('id', unitId) : query.eq('unit_number', Number(unitNumber));
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw assignmentError('Selected unit does not exist.');
  return data;
};

const assertSupabaseUnitAvailable = async (propertyId, unit, tenantId) => {
  let query = supabase
    .from('tenants')
    .select('id')
    .eq('property_id', propertyId)
    .eq('unit_id', unit.id)
    .eq('status', 'Active');
  if (tenantId) query = query.neq('id', tenantId);
  const { data, error } = await query.limit(1);

  if (error) throw error;
  if (data?.length) throw assignmentError('This unit is already assigned to an active tenant.');
};

export const createTenant = async (payload) => {
  if (supabase) {
    try {
      const propertyId = await ensureProperty();
      const unit = await getSupabaseUnit(propertyId, payload.unit_id, payload.unit_number);
      if (payload.status === 'Active') {
        await assertSupabaseUnitAvailable(propertyId, unit);
      }

      const { data, error } = await supabase.from('tenants').insert([{
        ...payload,
        property_id: propertyId,
        unit_id: unit.id,
        unit_number: unit.unit_number,
      }]).select().single();
      if (error) throw error;

      const { error: unitError } = await supabase.from('units').update({
        status: payload.status === 'Active' ? 'occupied' : 'vacant',
        occupancy: payload.status === 'Active' ? 'Occupied' : 'Vacant',
      }).eq('id', unit.id).eq('property_id', propertyId);
      if (unitError) throw unitError;
      return data;
    } catch (error) {
      if (error.code === 'TENANT_ASSIGNMENT_VALIDATION') throw error;
      console.warn('Supabase tenant create failed, writing to local fallback store.', error?.message || error);
    }
  }

  const state = loadData();
  const unit = resolveLocalUnit(state, payload.unit_id, payload.unit_number);
  if (payload.status === 'Active' && hasOtherActiveLocalTenant(state, unit)) {
    throw assignmentError('This unit is already assigned to an active tenant.');
  }

  const tenant = {
    id: crypto.randomUUID(),
    ...payload,
    unit_id: unit.id,
    unit_number: Number(unit.unit_number ?? unit.unitNumber),
  };
  state.tenants = state.tenants || [];
  state.tenants.push(tenant);
  synchronizeLocalUnit(unit, tenant.id, tenant.status === 'Active');
  saveData(state);
  return tenant;
};

export const updateTenant = async (id, payload) => {
  if (supabase) {
    try {
      const propertyId = await ensureProperty();
      const unit = await getSupabaseUnit(propertyId, payload.unit_id, payload.unit_number);
      if (payload.status === 'Active') {
        await assertSupabaseUnitAvailable(propertyId, unit, id);
      }

      const { data: currentTenant, error: currentError } = await supabase
        .from('tenants')
        .select('unit_id')
        .eq('id', id)
        .eq('property_id', propertyId)
        .single();
      if (currentError) throw currentError;

      const { data, error } = await supabase.from('tenants').update({
        ...payload,
        unit_id: unit.id,
        unit_number: unit.unit_number,
      }).eq('id', id).eq('property_id', propertyId).select().single();
      if (error) throw error;

      if (currentTenant.unit_id && currentTenant.unit_id !== unit.id) {
        await supabase.from('units').update({ status: 'vacant', occupancy: 'Vacant' })
          .eq('id', currentTenant.unit_id).eq('property_id', propertyId);
      }
      const { error: unitError } = await supabase.from('units').update({
        status: payload.status === 'Active' ? 'occupied' : 'vacant',
        occupancy: payload.status === 'Active' ? 'Occupied' : 'Vacant',
      }).eq('id', unit.id).eq('property_id', propertyId);
      if (unitError) throw unitError;
      return data;
    } catch (error) {
      if (error.code === 'TENANT_ASSIGNMENT_VALIDATION') throw error;
      console.warn('Supabase tenant update failed, writing to local fallback store.', error?.message || error);
    }
  }

  const state = loadData();
  const tenants = state.tenants || [];
  const tenantIndex = tenants.findIndex((entry) => String(entry.id) === String(id));
  if (tenantIndex === -1) throw new Error('Record not found.');

  const currentTenant = tenants[tenantIndex];
  const unit = resolveLocalUnit(state, payload.unit_id, payload.unit_number);
  if (payload.status === 'Active' && hasOtherActiveLocalTenant(state, unit, id)) {
    throw assignmentError('This unit is already assigned to an active tenant.');
  }

  const previousUnit = resolveLocalUnit(state, currentTenant.unit_id, currentTenant.unit_number);
  tenants[tenantIndex] = {
    ...currentTenant,
    ...payload,
    unit_id: unit.id,
    unit_number: Number(unit.unit_number ?? unit.unitNumber),
  };
  if (String(previousUnit.id) !== String(unit.id)) {
    synchronizeLocalUnit(previousUnit, null, false);
  }
  synchronizeLocalUnit(unit, id, payload.status === 'Active');
  saveData(state);
  return tenants[tenantIndex];
};

const getLocalPaymentContext = (state, payload) => {
  const tenant = (state.tenants || []).find((entry) => String(entry.id) === String(payload.tenant_id));
  if (!tenant) throw assignmentError('Selected tenant does not exist.');

  const tenantUnitNumber = Number(tenant.unit_number ?? tenant.unitNumber);
  const unit = (state.units || []).find((entry) => (
    (payload.unit_id && String(entry.id) === String(payload.unit_id))
    || (!payload.unit_id && tenant.unit_id && String(entry.id) === String(tenant.unit_id))
    || (!payload.unit_id && !tenant.unit_id && Number(entry.unit_number ?? entry.unitNumber) === tenantUnitNumber)
  ));
  if (!unit) throw assignmentError('Selected unit does not exist.');

  const unitNumber = Number(unit.unit_number ?? unit.unitNumber);
  if (unitNumber !== Number(payload.unit_number)
    || (tenant.unit_id && String(tenant.unit_id) !== String(unit.id))
    || (!tenant.unit_id && tenantUnitNumber !== unitNumber)) {
    throw assignmentError('Selected unit does not match the selected tenant.');
  }

  return { unit, unitNumber };
};

const getSupabasePaymentContext = async (propertyId, payload) => {
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, unit_id, unit_number')
    .eq('id', payload.tenant_id)
    .eq('property_id', propertyId)
    .maybeSingle();
  if (tenantError) throw tenantError;
  if (!tenant) throw assignmentError('Selected tenant does not exist.');

  const unit = await getSupabaseUnit(propertyId, payload.unit_id, payload.unit_number);
  if ((tenant.unit_id && String(tenant.unit_id) !== String(unit.id))
    || (!tenant.unit_id && Number(tenant.unit_number) !== Number(unit.unit_number))) {
    throw assignmentError('Selected unit does not match the selected tenant.');
  }

  return { unit };
};

export const createPayment = async (payload) => {
  if (supabase) {
    try {
      const propertyId = await ensureProperty();
      const { unit } = await getSupabasePaymentContext(propertyId, payload);
      const paymentPayload = {
        ...payload,
        status: calculatePaymentStatus(payload),
        property_id: propertyId,
        unit_id: unit.id,
        unit_number: unit.unit_number,
      };
      const { data, error } = await supabase.from('payments').insert([paymentPayload]).select().single();
      if (error) throw error;
      return { ...data, status: calculatePaymentStatus(data) };
    } catch (error) {
      if (error.code === 'TENANT_ASSIGNMENT_VALIDATION') throw error;
      console.warn('Supabase payment create failed, writing to local fallback store.', error?.message || error);
    }
  }

  const state = loadData();
  const { unit, unitNumber } = getLocalPaymentContext(state, payload);
  const payment = {
    id: crypto.randomUUID(),
    ...payload,
    status: calculatePaymentStatus(payload),
    unit_id: unit.id,
    unit_number: unitNumber,
  };
  state.payments = state.payments || [];
  state.payments.push(payment);
  saveData(state);
  return payment;
};

export const updatePayment = async (id, payload) => {
  if (supabase) {
    try {
      const propertyId = await ensureProperty();
      const { unit } = await getSupabasePaymentContext(propertyId, payload);
      const paymentPayload = {
        ...payload,
        status: calculatePaymentStatus(payload),
        unit_id: unit.id,
        unit_number: unit.unit_number,
      };
      const { data, error } = await supabase.from('payments').update(paymentPayload).eq('id', id).eq('property_id', propertyId).select().single();
      if (error) throw error;
      return { ...data, status: calculatePaymentStatus(data) };
    } catch (error) {
      if (error.code === 'TENANT_ASSIGNMENT_VALIDATION') throw error;
      console.warn('Supabase payment update failed, writing to local fallback store.', error?.message || error);
    }
  }

  const state = loadData();
  const payments = state.payments || [];
  const paymentIndex = payments.findIndex((entry) => String(entry.id) === String(id));
  if (paymentIndex === -1) throw new Error('Record not found.');
  const { unit, unitNumber } = getLocalPaymentContext(state, payload);
  payments[paymentIndex] = {
    ...payments[paymentIndex],
    ...payload,
    status: calculatePaymentStatus(payload),
    unit_id: unit.id,
    unit_number: unitNumber,
  };
  saveData(state);
  return payments[paymentIndex];
};

export const createEntity = async (entityName, payload) => {
  if (supabase) {
    try {
      const propertyId = await ensureProperty();
      const insertPayload = {
        ...payload,
        property_id: propertyId,
        id: payload.id || crypto.randomUUID(),
      };

      const { data, error } = await supabase.from(entityName).insert([insertPayload]).select().single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.warn('Supabase create failed, writing to local fallback store.', error?.message || error);
    }
  }

  const state = loadData();
  const next = { id: crypto.randomUUID(), ...payload };
  state[entityName] = state[entityName] || [];
  state[entityName].push(next);
  saveData(state);
  return next;
};

export const updateEntity = async (entityName, id, payload) => {
  if (supabase) {
    try {
      const { data, error } = await supabase.from(entityName).update(payload).eq('id', id).select().single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.warn('Supabase update failed, writing to local fallback store.', error?.message || error);
    }
  }

  const state = loadData();
  const list = state[entityName] || [];
  const index = list.findIndex((entry) => entry.id === id);
  if (index === -1) {
    throw new Error('Record not found.');
  }
  list[index] = { ...list[index], ...payload };
  saveData(state);
  return list[index];
};

export const deleteEntity = async (entityName, id) => {
  if (supabase) {
    try {
      const { error } = await supabase.from(entityName).delete().eq('id', id);
      if (error) throw error;
      return true;
    } catch (error) {
      console.warn('Supabase delete failed, removing from local fallback store.', error?.message || error);
    }
  }

  const state = loadData();
  const list = state[entityName] || [];
  state[entityName] = list.filter((entry) => entry.id !== id);
  saveData(state);
  return true;
};
