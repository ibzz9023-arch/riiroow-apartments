import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

mock.module(new URL('../src/supabaseClient.js', import.meta.url).href, {
  exports: { supabaseServiceRole: null },
});

const { recordRentReceipt } = await import('../src/financialManagement.js');

test('financial writes fail closed without a dedicated service-role client', async () => {
  await assert.rejects(
    recordRentReceipt({
      actorId: 'c0a80123-4567-4890-8123-456789abcdef',
      body: {
        tenantId: 'c0a80123-4567-4890-8123-456789abcdee',
        propertyId: 'c0a80123-4567-4890-8123-456789abcded',
        amount: '100.00',
        receivedOn: '2026-11-03',
        paymentMethod: 'Cash',
        idempotencyKey: 'c0a80123-4567-4890-8123-456789abcd01',
      },
    }),
    (error) => error.code === 'FINANCIAL_CONFIGURATION'
  );
});
