import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from '@e965/xlsx';
import { createPaymentLedgerWorkbook, createReportWorkbook } from '../src/reportExport.js';

test('report export creates an Excel workbook with operational data and no user secrets', async () => {
  const bytes = await createReportWorkbook({
    stats: { totalUnits: 1, occupiedUnits: 1, totalMonthlyRent: 1500, paidPayments: 500 },
    units: [{ id: 'unit-safe', unit_number: 101, rent: 1500, password: 'must-not-export' }],
    tenants: [{ id: 'tenant-safe', name: 'Demo Tenant', unit_number: 101, email: 'demo@example.invalid', password: 'must-not-export' }],
    leases: [{ id: 'lease-safe', tenant_id: 'tenant-safe', unit_number: 101, monthly_rent: 1500, security_deposit: 1000 }],
    payments: [{ id: 'payment-safe', tenant_id: 'tenant-safe', unit_number: 101, amount: 1000, paid_amount: 500, remaining_amount: 500 }],
    maintenance: [{ id: 'request-safe', unit_number: 101, title: 'Test repair', status: 'Pending' }],
    users: [{ email: 'admin@example.invalid', password: 'must-not-export', apiKey: 'must-not-export' }],
  });
  const workbook = XLSX.read(bytes, { type: 'array' });

  assert.deepEqual(workbook.SheetNames, [
    'Summary', 'Units', 'Tenants', 'Leases', 'Payments', 'Maintenance',
  ]);
  const paymentRows = XLSX.utils.sheet_to_json(workbook.Sheets.Payments, { header: 1 });
  assert.equal(paymentRows[1][6], 500);

  const exportedText = workbook.SheetNames
    .flatMap((name) => XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1 }).flat())
    .join(' ');
  assert.doesNotMatch(exportedText, /must-not-export|apiKey|password/i);
});

test('payment ledger exports every lease month, missing payments, tenant, and payment detail', async () => {
  const bytes = await createPaymentLedgerWorkbook({
    tenants: [
      { id: 'tenant-a', name: 'Ada Tenant', unit_number: 101 },
      { id: 'tenant-b', name: 'Bea Tenant', unit_number: 102 },
      { id: 'tenant-c', name: 'Cy Tenant', unit_number: 103 },
    ],
    leases: [{
      tenant_id: 'tenant-a',
      unit_number: 101,
      start_date: '2099-01-15',
      end_date: '2099-03-31',
      monthly_rent: 1000,
    }],
    payments: [
      {
        tenant_id: 'tenant-a',
        unit_number: 101,
        due_date: '2099-02-01',
        paid_date: '2099-02-03',
        amount: 1000,
        paid_amount: 750,
        remaining_amount: 250,
        status: 'Partially Paid',
        method: 'ACH',
        notes: 'Partial rent payment',
        payment_reference: 'REF-2099-02',
      },
      {
        tenant_id: 'tenant-b',
        unit_number: 102,
        due_date: '2099-04-01',
        amount: 1200,
        paid_amount: 1200,
        status: 'Paid',
        method: 'Check',
      },
    ],
  });
  const workbook = XLSX.read(bytes, { type: 'array' });
  assert.deepEqual(workbook.SheetNames, ['Payment Ledger']);

  const [headers, ...rows] = XLSX.utils.sheet_to_json(workbook.Sheets['Payment Ledger'], {
    header: 1,
    defval: '',
  });
  const ledger = rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
  const adaRows = ledger.filter((row) => row['Tenant name'] === 'Ada Tenant');
  assert.deepEqual(adaRows.map((row) => row['Month/period']), ['2099-01', '2099-02', '2099-03']);
  assert.equal(adaRows[0]['Due date'], '2099-01-15');
  assert.equal(adaRows[0]['Amount paid'], 0);
  assert.equal(adaRows[0]['Remaining balance'], 1000);
  assert.equal(adaRows[1]['Amount paid'], 750);
  assert.equal(adaRows[1]['Remaining balance'], 250);
  assert.equal(adaRows[1]['Payment date'], '2099-02-03');
  assert.equal(adaRows[1].Method, 'ACH');
  assert.equal(adaRows[1].Notes, 'Partial rent payment');
  assert.equal(adaRows[1]['Payment reference'], 'REF-2099-02');

  const beaRow = ledger.find((row) => row['Tenant name'] === 'Bea Tenant');
  assert.equal(beaRow['Month/period'], '2099-04');
  assert.equal(beaRow.Method, 'Check');
  const cyRow = ledger.find((row) => row['Tenant name'] === 'Cy Tenant');
  assert.equal(cyRow.Status, 'No lease period');
  assert.ok(headers.includes('Payment reference'));
});