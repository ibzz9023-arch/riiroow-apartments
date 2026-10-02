import * as XLSX from '@e965/xlsx';

const readField = (record, ...keys) => {
  for (const key of keys) {
    if (record?.[key] !== undefined && record[key] !== null) return record[key];
  }

  return '';
};

const addTable = (workbook, name, columns, rows) => {
  const sheetRows = [
    columns.map((column) => column.header),
    ...rows.map((row) => columns.map((column) => row[column.key] ?? '')),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  const lastRow = Math.max(sheetRows.length, 1);
  const lastColumn = columns.length - 1;

  sheet['!cols'] = columns.map((column) => ({ wch: column.width }));
  sheet['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow - 1, c: lastColumn } }),
  };

  columns.forEach((column, columnIndex) => {
    if (!column.numFmt) return;
    for (let rowIndex = 1; rowIndex < sheetRows.length; rowIndex += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      if (cell && typeof cell.v === 'number') cell.z = column.numFmt;
    }
  });

  XLSX.utils.book_append_sheet(workbook, sheet, name);
};

const records = (value) => (Array.isArray(value) ? value : []);

const dateOnly = (value) => {
  const date = String(value ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? '' : date;
};

const monthOf = (date) => (date ? date.slice(0, 7) : '');

const monthAfter = (month) => {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 7);
};

const numberValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const paymentReference = (payment) => readField(
  payment,
  'reference',
  'paymentReference',
  'payment_reference',
  'transactionReference',
  'transaction_reference',
  'transactionId',
  'transaction_id',
);

const createLedgerRow = ({ tenant, lease, payment, period, dueDate }) => {
  const amountValue = payment ? readField(payment, 'amount', 'amount_due') : readField(lease, 'monthlyRent', 'monthly_rent');
  const amountDue = amountValue === '' ? '' : numberValue(amountValue);
  const paidValue = payment ? readField(payment, 'paidAmount', 'paid_amount') : '';
  const paymentDate = payment ? dateOnly(readField(payment, 'paidDate', 'paid_date')) : '';
  const paidAmount = !payment
    ? 0
    : paidValue !== ''
      ? numberValue(paidValue)
      : String(readField(payment, 'status')).toLowerCase().includes('paid') || paymentDate
        ? numberValue(amountDue)
        : 0;
  const remainingValue = payment ? readField(payment, 'remainingAmount', 'remaining_amount') : '';
  const remainingBalance = !payment
    ? numberValue(amountDue)
    : remainingValue !== ''
      ? numberValue(remainingValue)
      : Math.max(0, numberValue(amountDue) - numberValue(paidAmount));
  const status = payment
    ? readField(payment, 'status') || (numberValue(paidAmount) >= numberValue(amountDue) ? 'Paid' : dueDate < new Date().toISOString().slice(0, 10) ? 'Overdue' : 'Outstanding')
    : dueDate < new Date().toISOString().slice(0, 10) ? 'Overdue' : 'Outstanding';

  return {
    tenantName: readField(tenant, 'name') || readField(payment, 'tenantName', 'tenant_name'),
    unit: readField(payment, 'unitNumber', 'unit_number') || readField(lease, 'unitNumber', 'unit_number') || readField(tenant, 'unitNumber', 'unit_number'),
    period,
    dueDate,
    amountDue,
    amountPaid: paidAmount,
    remainingBalance,
    status,
    paymentDate,
    method: payment ? readField(payment, 'method') : '',
    notes: payment ? readField(payment, 'notes') : '',
    reference: payment ? paymentReference(payment) : '',
  };
};

const paymentMatchesLeaseMonth = (payment, lease, tenantId, period) => {
  if (String(readField(payment, 'tenantId', 'tenant_id')) !== String(tenantId)) return false;
  if (monthOf(dateOnly(readField(payment, 'dueDate', 'due_date'))) !== period) return false;

  const paymentUnitId = readField(payment, 'unitId', 'unit_id');
  const leaseUnitId = readField(lease, 'unitId', 'unit_id');
  if (paymentUnitId && leaseUnitId && String(paymentUnitId) !== String(leaseUnitId)) return false;

  const paymentUnitNumber = readField(payment, 'unitNumber', 'unit_number');
  const leaseUnitNumber = readField(lease, 'unitNumber', 'unit_number');
  return !paymentUnitNumber || !leaseUnitNumber || String(paymentUnitNumber) === String(leaseUnitNumber);
};

const createPaymentLedgerRows = (dashboard = {}) => {
  const tenants = records(dashboard.tenants);
  const leases = records(dashboard.leases);
  const payments = records(dashboard.payments);
  const tenantsById = new Map(tenants.map((tenant) => [String(readField(tenant, 'id')), tenant]));
  const exportedPayments = new Set();
  const exportedTenantIds = new Set();
  const rows = [];
  const currentMonth = new Date().toISOString().slice(0, 7);

  leases.forEach((lease) => {
    const tenantId = readField(lease, 'tenantId', 'tenant_id');
    const startDate = dateOnly(readField(lease, 'startDate', 'start_date'));
    if (!startDate) return;

    const endDate = dateOnly(readField(lease, 'endDate', 'end_date'));
    const firstMonth = monthOf(startDate);
    const lastMonth = endDate ? monthOf(endDate) : currentMonth;
    if (lastMonth < firstMonth) return;

    const tenant = tenantsById.get(String(tenantId));
    exportedTenantIds.add(String(tenantId));
    for (let period = firstMonth; period <= lastMonth; period = monthAfter(period)) {
      const periodPayments = tenantId
        ? payments.filter((payment) => !exportedPayments.has(payment) && paymentMatchesLeaseMonth(payment, lease, tenantId, period))
        : [];

      if (periodPayments.length) {
        periodPayments.forEach((payment) => {
          const dueDate = dateOnly(readField(payment, 'dueDate', 'due_date'));
          rows.push(createLedgerRow({ tenant, lease, payment, period, dueDate }));
          exportedPayments.add(payment);
        });
      } else {
        const firstOfMonth = `${period}-01`;
        const dueDate = period === firstMonth && startDate > firstOfMonth ? startDate : firstOfMonth;
        rows.push(createLedgerRow({ tenant, lease, period, dueDate }));
      }
    }
  });

  payments.forEach((payment) => {
    if (exportedPayments.has(payment)) return;
    const tenantId = readField(payment, 'tenantId', 'tenant_id');
    const tenant = tenantsById.get(String(tenantId));
    const dueDate = dateOnly(readField(payment, 'dueDate', 'due_date'));
    rows.push(createLedgerRow({ tenant, payment, period: monthOf(dueDate), dueDate }));
    if (tenantId !== '') exportedTenantIds.add(String(tenantId));
  });

  tenants.forEach((tenant) => {
    const tenantId = String(readField(tenant, 'id'));
    if (exportedTenantIds.has(tenantId)) return;
    rows.push({
      tenantName: readField(tenant, 'name'),
      unit: readField(tenant, 'unitNumber', 'unit_number'),
      period: '',
      dueDate: '',
      amountDue: '',
      amountPaid: '',
      remainingBalance: '',
      status: 'No lease period',
      paymentDate: '',
      method: '',
      notes: '',
      reference: '',
    });
  });

  return rows.sort((left, right) => String(left.tenantName).localeCompare(String(right.tenantName))
    || String(left.period).localeCompare(String(right.period))
    || String(left.unit).localeCompare(String(right.unit)));
};

export const createPaymentLedgerWorkbook = async (dashboard = {}) => {
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Author: 'Riiroow Apartments', CreatedDate: new Date() };

  addTable(workbook, 'Payment Ledger', [
    { header: 'Tenant name', key: 'tenantName', width: 28 },
    { header: 'Unit', key: 'unit', width: 14 },
    { header: 'Month/period', key: 'period', width: 16 },
    { header: 'Due date', key: 'dueDate', width: 16 },
    { header: 'Amount due', key: 'amountDue', width: 16, numFmt: '$#,##0.00' },
    { header: 'Amount paid', key: 'amountPaid', width: 16, numFmt: '$#,##0.00' },
    { header: 'Remaining balance', key: 'remainingBalance', width: 20, numFmt: '$#,##0.00' },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Payment date', key: 'paymentDate', width: 16 },
    { header: 'Method', key: 'method', width: 18 },
    { header: 'Notes', key: 'notes', width: 36 },
    { header: 'Payment reference', key: 'reference', width: 24 },
  ], createPaymentLedgerRows(dashboard));

  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
};

export const createReportWorkbook = async (dashboard = {}) => {
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Author: 'Riiroow Apartments', CreatedDate: new Date() };

  const units = records(dashboard.units);
  const tenants = records(dashboard.tenants);
  const leases = records(dashboard.leases);
  const payments = records(dashboard.payments);
  const maintenance = records(dashboard.maintenance);
  const stats = dashboard.stats || {};

  addTable(workbook, 'Summary', [
    { header: 'Metric', key: 'metric', width: 30 },
    { header: 'Value', key: 'value', width: 22 },
  ], [
    { metric: 'Generated', value: new Date().toISOString().slice(0, 10) },
    { metric: 'Total units', value: stats.totalUnits ?? units.length },
    { metric: 'Occupied units', value: stats.occupiedUnits ?? '' },
    { metric: 'Vacant units', value: stats.vacantUnits ?? '' },
    { metric: 'Occupancy rate (%)', value: stats.occupancyRate ?? '' },
    { metric: 'Scheduled monthly rent', value: stats.totalMonthlyRent ?? '' },
    { metric: 'Payments received', value: stats.paidPayments ?? '' },
    { metric: 'Outstanding balance', value: stats.totalOutstanding ?? '' },
    { metric: 'Overdue balance', value: stats.totalOverdue ?? '' },
    { metric: 'Active leases', value: leases.filter((lease) => String(readField(lease, 'status')).toLowerCase() === 'active').length },
    { metric: 'Open maintenance requests', value: stats.openMaintenance ?? '' },
  ]);

  addTable(workbook, 'Units', [
    { header: 'ID', key: 'id', width: 38 },
    { header: 'Unit', key: 'unitNumber', width: 14 },
    { header: 'Floor', key: 'floor', width: 12 },
    { header: 'Bedrooms', key: 'bedrooms', width: 14 },
    { header: 'Bathrooms', key: 'bathrooms', width: 14 },
    { header: 'Monthly rent', key: 'rent', width: 18, numFmt: '$#,##0.00' },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Occupancy', key: 'occupancy', width: 16 },
  ], units.map((unit) => ({
    id: readField(unit, 'id'),
    unitNumber: readField(unit, 'unitNumber', 'unit_number'),
    floor: readField(unit, 'floor'),
    bedrooms: readField(unit, 'bedrooms'),
    bathrooms: readField(unit, 'bathrooms'),
    rent: readField(unit, 'rent'),
    status: readField(unit, 'status'),
    occupancy: readField(unit, 'occupancy'),
  })));

  addTable(workbook, 'Tenants', [
    { header: 'ID', key: 'id', width: 38 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Unit', key: 'unitNumber', width: 14 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Phone', key: 'phone', width: 20 },
    { header: 'Move-in date', key: 'moveInDate', width: 18 },
    { header: 'Status', key: 'status', width: 16 },
  ], tenants.map((tenant) => ({
    id: readField(tenant, 'id'),
    name: readField(tenant, 'name'),
    unitNumber: readField(tenant, 'unitNumber', 'unit_number'),
    email: readField(tenant, 'email'),
    phone: readField(tenant, 'phone'),
    moveInDate: readField(tenant, 'moveInDate', 'move_in_date'),
    status: readField(tenant, 'status'),
  })));

  addTable(workbook, 'Leases', [
    { header: 'ID', key: 'id', width: 38 },
    { header: 'Tenant ID', key: 'tenantId', width: 38 },
    { header: 'Unit', key: 'unitNumber', width: 14 },
    { header: 'Start date', key: 'startDate', width: 18 },
    { header: 'End date', key: 'endDate', width: 18 },
    { header: 'Monthly rent', key: 'monthlyRent', width: 18, numFmt: '$#,##0.00' },
    { header: 'Security deposit', key: 'securityDeposit', width: 20, numFmt: '$#,##0.00' },
    { header: 'Status', key: 'status', width: 16 },
  ], leases.map((lease) => ({
    id: readField(lease, 'id'),
    tenantId: readField(lease, 'tenantId', 'tenant_id'),
    unitNumber: readField(lease, 'unitNumber', 'unit_number'),
    startDate: readField(lease, 'startDate', 'start_date'),
    endDate: readField(lease, 'endDate', 'end_date'),
    monthlyRent: readField(lease, 'monthlyRent', 'monthly_rent'),
    securityDeposit: readField(lease, 'securityDeposit', 'security_deposit'),
    status: readField(lease, 'status'),
  })));

  addTable(workbook, 'Payments', [
    { header: 'ID', key: 'id', width: 38 },
    { header: 'Tenant ID', key: 'tenantId', width: 38 },
    { header: 'Unit', key: 'unitNumber', width: 14 },
    { header: 'Due date', key: 'dueDate', width: 18 },
    { header: 'Paid date', key: 'paidDate', width: 18 },
    { header: 'Amount due', key: 'amount', width: 18, numFmt: '$#,##0.00' },
    { header: 'Amount paid', key: 'paidAmount', width: 18, numFmt: '$#,##0.00' },
    { header: 'Remaining', key: 'remainingAmount', width: 18, numFmt: '$#,##0.00' },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Method', key: 'method', width: 18 },
  ], payments.map((payment) => ({
    id: readField(payment, 'id'),
    tenantId: readField(payment, 'tenantId', 'tenant_id'),
    unitNumber: readField(payment, 'unitNumber', 'unit_number'),
    dueDate: readField(payment, 'dueDate', 'due_date'),
    paidDate: readField(payment, 'paidDate', 'paid_date'),
    amount: readField(payment, 'amount'),
    paidAmount: readField(payment, 'paidAmount', 'paid_amount'),
    remainingAmount: readField(payment, 'remainingAmount', 'remaining_amount'),
    status: readField(payment, 'status'),
    method: readField(payment, 'method'),
  })));

  addTable(workbook, 'Maintenance', [
    { header: 'ID', key: 'id', width: 38 },
    { header: 'Unit', key: 'unitNumber', width: 14 },
    { header: 'Title', key: 'title', width: 32 },
    { header: 'Description', key: 'description', width: 48 },
    { header: 'Priority', key: 'priority', width: 16 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Assigned technician', key: 'assignedTechnician', width: 26 },
    { header: 'Request date', key: 'requestDate', width: 18 },
    { header: 'Due date', key: 'dueDate', width: 18 },
    { header: 'Completion date', key: 'completionDate', width: 20 },
  ], maintenance.map((item) => ({
    id: readField(item, 'id'),
    unitNumber: readField(item, 'unitNumber', 'unit_number'),
    title: readField(item, 'title'),
    description: readField(item, 'description'),
    priority: readField(item, 'priority'),
    status: readField(item, 'status'),
    assignedTechnician: readField(item, 'assignedTechnician', 'assigned_technician'),
    requestDate: readField(item, 'requestDate', 'request_date'),
    dueDate: readField(item, 'dueDate', 'due_date'),
    completionDate: readField(item, 'completionDate', 'completion_date'),
  })));

  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
};