import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataFilePath = path.join(__dirname, '..', 'data', 'store.json');

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
const statusMatches = (value, expected) => normalizeMaintenanceStatus(value).toLowerCase() === expected.toLowerCase();
const priorityMatches = (value, expected) => normalizeMaintenancePriority(value).toLowerCase() === expected.toLowerCase();

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

  const tenants = [
    { id: 'tenant-101', name: 'Alicia Gomez', unitNumber: 101, email: 'alicia@riiroow.com', phone: '(555) 111-0101', moveInDate: '2025-01-15', status: 'Active' },
    { id: 'tenant-102', name: 'Marcus Hill', unitNumber: 102, email: 'marcus@riiroow.com', phone: '(555) 111-0102', moveInDate: '2025-02-01', status: 'Active' },
    { id: 'tenant-201', name: 'Tara Nguyen', unitNumber: 201, email: 'tara@riiroow.com', phone: '(555) 111-0201', moveInDate: '2024-11-10', status: 'Active' },
    { id: 'tenant-202', name: 'Daniel Brooks', unitNumber: 202, email: 'daniel@riiroow.com', phone: '(555) 111-0202', moveInDate: '2025-03-05', status: 'Active' },
    { id: 'tenant-301', name: 'Priya Shah', unitNumber: 301, email: 'priya@riiroow.com', phone: '(555) 111-0301', moveInDate: '2024-08-22', status: 'Active' },
    { id: 'tenant-302', name: 'Evan Foster', unitNumber: 302, email: 'evan@riiroow.com', phone: '(555) 111-0302', moveInDate: '2025-04-09', status: 'Active' },
    { id: 'tenant-401', name: 'Monica Lee', unitNumber: 401, email: 'monica@riiroow.com', phone: '(555) 111-0401', moveInDate: '2024-12-17', status: 'Active' },
    { id: 'tenant-402', name: 'Oscar Reed', unitNumber: 402, email: 'oscar@riiroow.com', phone: '(555) 111-0402', moveInDate: '2025-01-29', status: 'Active' },
    { id: 'tenant-501', name: 'Julia Park', unitNumber: 501, email: 'julia@riiroow.com', phone: '(555) 111-0501', moveInDate: '2025-05-11', status: 'Active' },
    { id: 'tenant-502', name: 'Samir Patel', unitNumber: 502, email: 'samir@riiroow.com', phone: '(555) 111-0502', moveInDate: '2024-10-03', status: 'Active' },
  ];

  const leases = [
    { id: 'lease-101', unitNumber: 101, tenantId: 'tenant-101', startDate: '2025-01-15', endDate: '2026-01-14', monthlyRent: 1850, status: 'Active' },
    { id: 'lease-102', unitNumber: 102, tenantId: 'tenant-102', startDate: '2025-02-01', endDate: '2026-02-01', monthlyRent: 1500, status: 'Active' },
    { id: 'lease-201', unitNumber: 201, tenantId: 'tenant-201', startDate: '2024-11-10', endDate: '2025-11-09', monthlyRent: 1900, status: 'Active' },
    { id: 'lease-202', unitNumber: 202, tenantId: 'tenant-202', startDate: '2025-03-05', endDate: '2026-03-04', monthlyRent: 1950, status: 'Active' },
    { id: 'lease-301', unitNumber: 301, tenantId: 'tenant-301', startDate: '2024-08-22', endDate: '2025-08-21', monthlyRent: 2000, status: 'Renewal due' },
    { id: 'lease-302', unitNumber: 302, tenantId: 'tenant-302', startDate: '2025-04-09', endDate: '2026-04-08', monthlyRent: 1650, status: 'Active' },
    { id: 'lease-401', unitNumber: 401, tenantId: 'tenant-401', startDate: '2024-12-17', endDate: '2025-12-16', monthlyRent: 2050, status: 'Active' },
    { id: 'lease-402', unitNumber: 402, tenantId: 'tenant-402', startDate: '2025-01-29', endDate: '2026-01-28', monthlyRent: 2100, status: 'Active' },
    { id: 'lease-501', unitNumber: 501, tenantId: 'tenant-501', startDate: '2025-05-11', endDate: '2026-05-10', monthlyRent: 2200, status: 'Active' },
    { id: 'lease-502', unitNumber: 502, tenantId: 'tenant-502', startDate: '2024-10-03', endDate: '2025-10-02', monthlyRent: 2250, status: 'Active' },
  ];

  const payments = [
    { id: 'pay-1', unitNumber: 101, tenantId: 'tenant-101', amount: 1850, dueDate: '2026-08-01', paidDate: '2026-08-02', status: 'Paid', method: 'ACH' },
    { id: 'pay-2', unitNumber: 102, tenantId: 'tenant-102', amount: 1500, dueDate: '2026-08-01', paidDate: '2026-08-10', status: 'Paid', method: 'Card' },
    { id: 'pay-3', unitNumber: 201, tenantId: 'tenant-201', amount: 1900, dueDate: '2026-08-01', paidDate: null, status: 'Overdue', method: 'ACH' },
    { id: 'pay-4', unitNumber: 202, tenantId: 'tenant-202', amount: 1950, dueDate: '2026-08-01', paidDate: null, status: 'Outstanding', method: 'Bank transfer' },
    { id: 'pay-5', unitNumber: 301, tenantId: 'tenant-301', amount: 2000, dueDate: '2026-08-01', paidDate: '2026-08-05', status: 'Paid', method: 'ACH' },
    { id: 'pay-6', unitNumber: 302, tenantId: 'tenant-302', amount: 1650, dueDate: '2026-08-01', paidDate: null, status: 'Outstanding', method: 'Card' },
    { id: 'pay-7', unitNumber: 401, tenantId: 'tenant-401', amount: 2050, dueDate: '2026-08-01', paidDate: '2026-08-01', status: 'Paid', method: 'ACH' },
    { id: 'pay-8', unitNumber: 402, tenantId: 'tenant-402', amount: 2100, dueDate: '2026-08-01', paidDate: null, status: 'Overdue', method: 'Check' },
    { id: 'pay-9', unitNumber: 501, tenantId: 'tenant-501', amount: 2200, dueDate: '2026-08-01', paidDate: '2026-08-04', status: 'Paid', method: 'ACH' },
    { id: 'pay-10', unitNumber: 502, tenantId: 'tenant-502', amount: 2250, dueDate: '2026-08-01', paidDate: null, status: 'Outstanding', method: 'Card' },
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
  const paidPayments = state.payments.filter((payment) => payment.status === 'Paid').reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const overduePayments = state.payments.filter((payment) => payment.status === 'Overdue' || payment.status === 'Outstanding').reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const maintenanceSummary = summarizeMaintenance(state.maintenance || []);

  return {
    stats: {
      totalUnits,
      occupiedUnits,
      vacantUnits,
      totalMonthlyRent,
      paidPayments,
      overduePayments,
      openMaintenance: maintenanceSummary.pendingRequests + maintenanceSummary.inProgressRequests,
      occupancyRate: totalUnits ? Math.round((occupiedUnits / totalUnits) * 100) : 0,
      ...maintenanceSummary,
    },
    units: state.units,
    tenants: state.tenants,
    leases: state.leases,
    payments: state.payments,
    maintenance: state.maintenance,
    maintenanceSummary,
  };
};
