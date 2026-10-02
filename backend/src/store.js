import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataFilePath = process.env.RIIROOW_DATA_FILE
  ? path.resolve(process.env.RIIROOW_DATA_FILE)
  : path.join(__dirname, '..', 'data', 'store.json');

const hashPassword = (value) =>
  crypto.pbkdf2Sync(String(value ?? ''), 'riiroow-apartments-v1', 100000, 64, 'sha512').toString('hex');

const generateUnit = (number, floor, bedrooms, rent) => ({
  id: `unit-${number}`,
  unitNumber: number,
  floor,
  bedrooms,
  rent,
  status: 'occupied',
  tenantId: `tenant-${number}`,
  leaseId: `lease-${number}`,
  lastPaymentDate: '2026-08-20',
  occupancy: 'Occupied',
});

const normalizeMaintenanceStatus = (value) => String(value || 'Pending').trim() || 'Pending';
const normalizeMaintenancePriority = (value) => String(value || 'Medium').trim() || 'Medium';
const normalizePaymentValue = (value) => String(value ?? '').trim();
const normalizeNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const statusMatches = (value, expected) => normalizeMaintenanceStatus(value).toLowerCase() === expected.toLowerCase();
const priorityMatches = (value, expected) => normalizeMaintenancePriority(value).toLowerCase() === expected.toLowerCase();
const hasValidPaymentDate = (value) => {
  const normalized = normalizePaymentValue(value);
  if (!normalized) return false;

  const parsed = new Date(`${normalized}T00:00:00`);
  return !Number.isNaN(parsed.getTime());
};

const getPaidAmount = (payment = {}) => {
  const rawPaidAmount = payment.paidAmount ?? payment.paid_amount;
  if (rawPaidAmount !== undefined && rawPaidAmount !== null && rawPaidAmount !== '') {
    return Math.max(0, normalizeNumber(rawPaidAmount));
  }

  const rawStatus = normalizePaymentValue(payment.status);
  const paidDate = normalizePaymentValue(payment.paidDate ?? payment.paid_date ?? '');

  if (rawStatus.toLowerCase().includes('paid') || hasValidPaymentDate(paidDate)) {
    return Math.max(0, normalizeNumber(payment.amount ?? payment.amount_due ?? 0));
  }

  return 0;
};

export const normalizePaymentRecord = (payment = {}) => {
  const amount = Math.max(0, normalizeNumber(payment.amount));
  const paidAmount = Math.max(0, Math.min(getPaidAmount(payment), amount));
  const remainingAmount = Math.max(0, amount - paidAmount);
  const status = calculatePaymentStatus({ ...payment, amount, paidAmount });

  return {
    ...payment,
    amount,
    paidAmount,
    remainingAmount,
    dueDate: payment.dueDate ?? payment.due_date ?? null,
    paidDate: payment.paidDate ?? payment.paid_date ?? null,
    status,
  };
};

export const calculatePaymentStatus = (payment = {}) => {
  const amount = Math.max(0, normalizeNumber(payment.amount));
  const paidAmount = Math.max(0, Math.min(normalizeNumber(payment.paidAmount ?? payment.paid_amount ?? 0), amount));
  const dueDate = normalizePaymentValue(payment.dueDate ?? payment.due_date ?? '');
  const rawStatus = normalizePaymentValue(payment.status);

  if (amount > 0 && paidAmount >= amount) {
    return 'Paid';
  }

  if (paidAmount > 0 && amount > 0 && paidAmount < amount) {
    return 'Partially Paid';
  }

  if (hasValidPaymentDate(dueDate)) {
    const due = new Date(`${dueDate}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return due < today ? 'Overdue' : 'Outstanding';
  }

  if (rawStatus.toLowerCase().includes('overdue')) return 'Overdue';
  if (rawStatus.toLowerCase().includes('paid')) return 'Paid';
  if (rawStatus.toLowerCase().includes('partial')) return 'Partially Paid';

  return 'Outstanding';
};

export const normalizePaymentRecords = (payments = []) => (payments || []).map((payment) => normalizePaymentRecord(payment));

export const seedState = () => {
  const units = [
    generateUnit(101, 1, 2, 1850),
    generateUnit(102, 1, 1, 1500),
    generateUnit(201, 2, 2, 1900),
    generateUnit(202, 2, 2, 1950),
    generateUnit(301, 3, 2, 2000),
    generateUnit(302, 3, 1, 1650),
    generateUnit(401, 4, 2, 2050),
    generateUnit(402, 4, 2, 2100),
    generateUnit(501, 5, 2, 2200),
    generateUnit(502, 5, 2, 2250),
  ];

  // Synthetic demo records exercise Payments -> Export without using real tenant data.
  const tenants = [
    { id: 'tenant-101', name: 'Demo Tenant 101', unitNumber: 101, email: 'demo.tenant101@example.invalid', phone: '(555) 010-0101', moveInDate: '2026-01-01', status: 'Active' },
    { id: 'tenant-102', name: 'Demo Tenant 102', unitNumber: 102, email: 'demo.tenant102@example.invalid', phone: '(555) 010-0102', moveInDate: '2026-01-01', status: 'Active' },
    { id: 'tenant-201', name: 'Demo Tenant 201', unitNumber: 201, email: 'demo.tenant201@example.invalid', phone: '(555) 010-0201', moveInDate: '2026-01-01', status: 'Active' },
    { id: 'tenant-202', name: 'Demo Tenant 202', unitNumber: 202, email: 'demo.tenant202@example.invalid', phone: '(555) 010-0202', moveInDate: '2026-01-01', status: 'Active' },
    { id: 'tenant-301', name: 'Demo Tenant 301', unitNumber: 301, email: 'demo.tenant301@example.invalid', phone: '(555) 010-0301', moveInDate: '2026-01-01', status: 'Active' },
    { id: 'tenant-302', name: 'Demo Tenant 302', unitNumber: 302, email: 'demo.tenant302@example.invalid', phone: '(555) 010-0302', moveInDate: '2026-01-01', status: 'Active' },
    { id: 'tenant-401', name: 'Demo Tenant 401', unitNumber: 401, email: 'demo.tenant401@example.invalid', phone: '(555) 010-0401', moveInDate: '2026-01-01', status: 'Active' },
    { id: 'tenant-402', name: 'Demo Tenant 402', unitNumber: 402, email: 'demo.tenant402@example.invalid', phone: '(555) 010-0402', moveInDate: '2026-01-01', status: 'Active' },
    { id: 'tenant-501', name: 'Demo Tenant 501', unitNumber: 501, email: 'demo.tenant501@example.invalid', phone: '(555) 010-0501', moveInDate: '2026-01-01', status: 'Active' },
    { id: 'tenant-502', name: 'Demo Tenant 502', unitNumber: 502, email: 'demo.tenant502@example.invalid', phone: '(555) 010-0502', moveInDate: '2026-01-01', status: 'Active' },
    { id: 'tenant-demo-unleased', name: 'Demo Tenant Without Lease', unitNumber: null, email: 'demo.unleased@example.invalid', phone: '(555) 010-0999', moveInDate: '2026-04-01', status: 'Pending' },
  ];

  const leases = [
    { id: 'lease-101', unitNumber: 101, tenantId: 'tenant-101', startDate: '2026-01-01', endDate: '2026-12-31', monthlyRent: 1850, status: 'Active' },
    { id: 'lease-102', unitNumber: 102, tenantId: 'tenant-102', startDate: '2026-01-01', endDate: '2026-12-31', monthlyRent: 1500, status: 'Active' },
    { id: 'lease-201', unitNumber: 201, tenantId: 'tenant-201', startDate: '2026-01-01', endDate: '2026-12-31', monthlyRent: 1900, status: 'Active' },
    { id: 'lease-202', unitNumber: 202, tenantId: 'tenant-202', startDate: '2026-01-01', endDate: '2026-12-31', monthlyRent: 1950, status: 'Active' },
    { id: 'lease-301', unitNumber: 301, tenantId: 'tenant-301', startDate: '2026-01-01', endDate: '2026-12-31', monthlyRent: 2000, status: 'Active' },
    { id: 'lease-302', unitNumber: 302, tenantId: 'tenant-302', startDate: '2026-01-01', endDate: '2026-12-31', monthlyRent: 1650, status: 'Active' },
    { id: 'lease-401', unitNumber: 401, tenantId: 'tenant-401', startDate: '2026-01-01', endDate: '2026-12-31', monthlyRent: 2050, status: 'Active' },
    { id: 'lease-402', unitNumber: 402, tenantId: 'tenant-402', startDate: '2026-01-01', endDate: '2026-12-31', monthlyRent: 2100, status: 'Active' },
    { id: 'lease-501', unitNumber: 501, tenantId: 'tenant-501', startDate: '2026-01-01', endDate: '2026-12-31', monthlyRent: 2200, status: 'Active' },
    { id: 'lease-502', unitNumber: 502, tenantId: 'tenant-502', startDate: '2026-01-01', endDate: '2026-12-31', monthlyRent: 2250, status: 'Active' },
  ];

  const payments = [
    { id: 'demo-pay-101-jan', unitNumber: 101, tenantId: 'tenant-101', amount: 1850, paidAmount: 1850, dueDate: '2026-01-01', paidDate: '2026-01-02', status: 'Paid', method: 'ACH', notes: 'Synthetic demo: paid in full.', reference: 'DEMO-101-2026-01' },
    { id: 'demo-pay-101-feb', unitNumber: 101, tenantId: 'tenant-101', amount: 1850, paidAmount: 900, dueDate: '2026-02-01', paidDate: '2026-02-03', status: 'Partially Paid', method: 'Card', notes: 'Synthetic demo: partial payment; balance remains.', reference: 'DEMO-101-2026-02' },
    { id: 'demo-pay-102-jan', unitNumber: 102, tenantId: 'tenant-102', amount: 1500, paidAmount: 1500, dueDate: '2026-01-01', paidDate: '2026-01-01', status: 'Paid', method: 'ACH', notes: 'Synthetic demo: paid in full.', reference: 'DEMO-102-2026-01' },
    { id: 'demo-pay-102-feb', unitNumber: 102, tenantId: 'tenant-102', amount: 1500, paidAmount: 0, dueDate: '2026-02-01', paidDate: null, status: 'Overdue', method: 'ACH', notes: 'Synthetic demo: no payment received.', reference: 'DEMO-102-2026-02' },
    { id: 'demo-pay-201-mar', unitNumber: 201, tenantId: 'tenant-201', amount: 1900, paidAmount: 1900, dueDate: '2026-03-01', paidDate: '2026-03-02', status: 'Paid', method: 'Check', notes: 'Synthetic demo: check cleared.', reference: 'DEMO-201-2026-03' },
    { id: 'demo-pay-202-apr', unitNumber: 202, tenantId: 'tenant-202', amount: 1950, paidAmount: 950, dueDate: '2026-04-01', paidDate: '2026-04-04', status: 'Partially Paid', method: 'Bank transfer', notes: 'Synthetic demo: partial bank transfer.', reference: 'DEMO-202-2026-04' },
    { id: 'demo-pay-301-may', unitNumber: 301, tenantId: 'tenant-301', amount: 2000, paidAmount: 0, dueDate: '2026-05-01', paidDate: null, status: 'Overdue', method: 'ACH', notes: 'Synthetic demo: missed rent period.', reference: 'DEMO-301-2026-05' },
    { id: 'demo-pay-302-jun', unitNumber: 302, tenantId: 'tenant-302', amount: 1650, paidAmount: 1650, dueDate: '2026-06-01', paidDate: '2026-06-01', status: 'Paid', method: 'Cash', notes: 'Synthetic demo: paid in full.', reference: 'DEMO-302-2026-06' },
    { id: 'demo-pay-401-jul', unitNumber: 401, tenantId: 'tenant-401', amount: 2050, paidAmount: 2050, dueDate: '2026-07-01', paidDate: '2026-07-05', status: 'Paid', method: 'ACH', notes: 'Synthetic demo: paid after due date.', reference: 'DEMO-401-2026-07' },
    { id: 'demo-pay-402-aug', unitNumber: 402, tenantId: 'tenant-402', amount: 2100, paidAmount: 1050, dueDate: '2026-08-01', paidDate: '2026-08-03', status: 'Partially Paid', method: 'Card', notes: 'Synthetic demo: half payment received.', reference: 'DEMO-402-2026-08' },
    { id: 'demo-pay-501-sep', unitNumber: 501, tenantId: 'tenant-501', amount: 2200, paidAmount: 0, dueDate: '2026-09-01', paidDate: null, status: 'Overdue', method: 'Bank transfer', notes: 'Synthetic demo: no payment received.', reference: 'DEMO-501-2026-09' },
    { id: 'demo-pay-502-oct', unitNumber: 502, tenantId: 'tenant-502', amount: 2250, paidAmount: 0, dueDate: '2026-10-01', paidDate: null, status: 'Outstanding', method: 'Check', notes: 'Synthetic demo: October rent unpaid.', reference: 'DEMO-502-2026-10' },
    { id: 'demo-pay-501-prior-lease', unitNumber: 501, tenantId: 'tenant-501', amount: 2200, paidAmount: 2200, dueDate: '2025-12-01', paidDate: '2025-12-02', status: 'Paid', method: 'ACH', notes: 'Synthetic demo: paid before current lease period.', reference: 'DEMO-501-2025-12' },
  ];

  const maintenance = [
    {
      id: 'maint-1',
      unitNumber: 201,
      tenantId: 'tenant-201',
      title: 'HVAC not cooling',
      description: 'Air conditioner is running but not cooling the living room',
      status: 'In Progress',
      priority: 'High',
      assignedTechnician: 'Luis Ortega',
      requestDate: '2026-08-15',
      dueDate: '2026-09-01',
      completionDate: '',
      reminderAt: '2026-09-01T09:00:00',
      notes: 'Customer reported poor airflow in living room.',
      createdAt: '2026-08-15',
    },
    {
      id: 'maint-2',
      unitNumber: 302,
      tenantId: 'tenant-302',
      title: 'Leaking kitchen sink',
      description: 'Drain pipe is leaking beneath sink cabinet',
      status: 'Pending',
      priority: 'Medium',
      assignedTechnician: 'Nina Patel',
      requestDate: '2026-08-18',
      dueDate: '2026-09-03',
      completionDate: '',
      reminderAt: '2026-09-02T14:00:00',
      notes: 'Check supply line and cabinet floor for moisture.',
      createdAt: '2026-08-18',
    },
    {
      id: 'maint-3',
      unitNumber: 502,
      tenantId: 'tenant-502',
      title: 'Light fixture replacement',
      description: 'Bathroom vanity light flickers after power surge',
      status: 'Completed',
      priority: 'Low',
      assignedTechnician: 'Carlos Diaz',
      requestDate: '2026-08-22',
      dueDate: '2026-08-26',
      completionDate: '2026-08-25',
      reminderAt: '2026-08-24T16:00:00',
      notes: 'Fixture replaced and switch tested.',
      createdAt: '2026-08-22',
    },
  ];

  const users = [
    { id: 'user-admin', name: 'Ava Thompson', email: 'admin@riiroow.com', password: hashPassword('admin123'), role: 'admin', permissions: ['all'] },
    { id: 'user-manager', name: 'Noah Smith', email: 'manager@riiroow.com', password: hashPassword('manager123'), role: 'manager', permissions: ['units', 'tenants', 'leases', 'dashboard'] },
    { id: 'user-accountant', name: 'Emma Clark', email: 'accountant@riiroow.com', password: hashPassword('accountant123'), role: 'accountant', permissions: ['payments', 'rent', 'reports'] },
    { id: 'user-maintenance', name: 'Lucas King', email: 'maintenance@riiroow.com', password: hashPassword('maintenance123'), role: 'maintenance', permissions: ['maintenance', 'units'] },
  ];

  return { units, tenants, leases, payments, maintenance, users };
};

export const loadData = () => {
  if (!fs.existsSync(dataFilePath)) {
    const seeded = seedState();
    saveData(seeded);
    return seeded;
  }

  const raw = fs.readFileSync(dataFilePath, 'utf8');
  if (!raw.trim()) {
    const seeded = seedState();
    saveData(seeded);
    return seeded;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const seeded = seedState();
    saveData(seeded);
    return seeded;
  }
};

export const saveData = (data) => {
  const folder = path.dirname(dataFilePath);
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }

  fs.writeFileSync(dataFilePath, JSON.stringify(data, null, 2));
};

export const summarizeMaintenance = (maintenance = []) => {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const pendingRequests = maintenance.filter((item) => statusMatches(item.status, 'Pending')).length;
  const inProgressRequests = maintenance.filter((item) => statusMatches(item.status, 'In Progress') || statusMatches(item.status, 'In progress')).length;
  const completedRequests = maintenance.filter((item) => statusMatches(item.status, 'Completed') || statusMatches(item.status, 'Resolved') || statusMatches(item.status, 'Closed')).length;
  const highPriorityRequests = maintenance.filter((item) => priorityMatches(item.priority, 'High')).length;
  const emergencyRequests = maintenance.filter((item) => priorityMatches(item.priority, 'Emergency')).length;
  const overdueRequests = maintenance.filter((item) => {
    if (!item.dueDate || statusMatches(item.status, 'Completed') || statusMatches(item.status, 'Resolved') || statusMatches(item.status, 'Closed')) return false;
    const dueDate = new Date(item.dueDate);
    return dueDate < startOfToday;
  }).length;
  const dueTodayRequests = maintenance.filter((item) => item.dueDate === todayIso && !statusMatches(item.status, 'Completed') && !statusMatches(item.status, 'Resolved') && !statusMatches(item.status, 'Closed')).length;
  const reminderItems = maintenance.filter((item) => {
    if (!item.reminderAt || statusMatches(item.status, 'Completed') || statusMatches(item.status, 'Resolved') || statusMatches(item.status, 'Closed')) return false;
    const reminderDate = new Date(item.reminderAt);
    return reminderDate >= startOfToday && reminderDate <= new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);
  }).length;

  return {
    totalRequests: maintenance.length,
    pendingRequests,
    inProgressRequests,
    completedRequests,
    overdueRequests,
    dueTodayRequests,
    highPriorityRequests,
    emergencyRequests,
    reminderItems,
  };
};

export const summarizeDashboard = (state) => {
  const totalUnits = state.units.length;
  const occupiedUnits = state.units.filter((unit) => unit.status === 'occupied').length;
  const vacantUnits = totalUnits - occupiedUnits;
  const totalMonthlyRent = state.units.reduce((sum, unit) => sum + Number(unit.rent || 0), 0);
  const normalizedPayments = normalizePaymentRecords(state.payments || []);
  const totalRentDue = normalizedPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const paidPayments = normalizedPayments.reduce((sum, payment) => sum + Number(payment.paidAmount || 0), 0);
  const totalRemaining = normalizedPayments.reduce((sum, payment) => sum + Number(payment.remainingAmount || 0), 0);
  const totalOutstanding = normalizedPayments.filter((payment) => payment.status === 'Outstanding').reduce((sum, payment) => sum + Number(payment.remainingAmount || 0), 0);
  const totalOverdue = normalizedPayments.filter((payment) => payment.status === 'Overdue').reduce((sum, payment) => sum + Number(payment.remainingAmount || 0), 0);
  const maintenanceSummary = summarizeMaintenance(state.maintenance || []);

  return {
    stats: {
      totalUnits,
      occupiedUnits,
      vacantUnits,
      totalMonthlyRent,
      totalRentDue,
      paidPayments,
      totalRemaining,
      totalOutstanding,
      totalOverdue,
      overduePayments: totalOutstanding + totalOverdue,
      openMaintenance: maintenanceSummary.pendingRequests + maintenanceSummary.inProgressRequests,
      occupancyRate: totalUnits ? Math.round((occupiedUnits / totalUnits) * 100) : 0,
      ...maintenanceSummary,
    },
    units: state.units,
    tenants: state.tenants,
    leases: state.leases,
    payments: normalizedPayments,
    maintenance: state.maintenance,
    maintenanceSummary,
  };
};
