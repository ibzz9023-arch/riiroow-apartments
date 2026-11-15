import { Router } from 'express';
import { requireRoles } from './authSession.js';
import * as financialManagement from './financialManagement.js';

const statusFor = (error) => {
  const match = /^HTTP_(\d{3})$/.exec(String(error?.code || ''));
  if (match) return Number(match[1]);
  if (error?.code === 'FINANCIAL_CONFIGURATION') return 503;
  if (error?.code === 'FINANCIAL_VALIDATION') return 400;
  return 500;
};

const sendError = (res, error, operation) => {
  const status = statusFor(error);
  if (status >= 500) {
    console.error(`Financial ${operation} failed:`, error?.code || error?.name || 'unknown');
  }
  return res.status(status).json({
    error: status >= 500
      ? 'Unable to complete the financial request.'
      : error.message,
  });
};

const endpoint = (operation, handler, successStatus = 200) => async (req, res) => {
  try {
    const result = await handler(req);
    return res.status(result?.duplicate ? 200 : successStatus).json(result);
  } catch (error) {
    return sendError(res, error, operation);
  }
};

export const createFinancialRouter = ({
  authorize = requireRoles,
  service = financialManagement,
} = {}) => {
  const router = Router();
  const authorizeRead = authorize('Admin', 'Manager', 'Accountant');
  const authorizeWrite = authorize('Admin', 'Manager');
  router.use((req, res, next) => (
    req.method === 'GET'
      ? authorizeRead(req, res, next)
      : authorizeWrite(req, res, next)
  ));

  router.get('/summary', endpoint('summary', (req) =>
    service.getFinancialSummary(req.query.month)
  ));
  router.get('/receipts', endpoint('receipt list', (req) =>
    service.listFinancialReceipts(req.query.month)
  ));
  router.post('/receipts', endpoint(
    'receipt recording',
    (req) => service.recordRentReceipt({
      body: {
        ...req.body,
        idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
      },
      actorId: req.auth.sub,
    }),
    201
  ));
  router.post('/receipts/notifications/:notificationId', endpoint(
    'notification receipt recording',
    (req) => service.recordRentReceipt({
      body: {
        ...req.body,
        idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
      },
      actorId: req.auth.sub,
      notificationId: req.params.notificationId,
    }),
    201
  ));
  router.post('/receipts/:receiptId/void', endpoint('receipt correction', (req) =>
    service.voidRentReceipt({
      receiptId: req.params.receiptId,
      body: {
        ...req.body,
        idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
      },
      actorId: req.auth.sub,
    })
  ));

  router.get('/credits', endpoint('credit list', () =>
    service.listTenantCredits()
  ));
  router.get('/credits/:accountId/transactions', endpoint('credit transaction list', (req) =>
    service.listTenantCreditTransactions(req.params.accountId)
  ));
  router.post('/credits/apply', endpoint('credit application', (req) =>
    service.applyTenantCredit({
      body: {
        ...req.body,
        idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
      },
      actorId: req.auth.sub,
    })
  ));
  router.post('/credits/refund', endpoint('credit refund', (req) =>
    service.refundTenantCredit({
      body: {
        ...req.body,
        idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
      },
      actorId: req.auth.sub,
    })
  ));

  router.get('/expense-categories', endpoint('expense category list', () =>
    service.listExpenseCategories()
  ));
  router.post('/expense-categories', endpoint(
    'expense category creation',
    (req) => service.createExpenseCategory({ body: req.body, actorId: req.auth.sub }),
    201
  ));
  router.get('/expenses', endpoint('expense list', (req) =>
    service.listFinancialExpenses(req.query.month)
  ));
  router.get('/legacy-balances', endpoint('legacy balance list', () =>
    service.listUndatedLegacyBalances()
  ));
  router.post('/legacy-balances/:balanceId/reconcile', endpoint(
    'legacy balance reconciliation',
    (req) => service.reconcileLegacyBalance({
      balanceId: req.params.balanceId,
      body: {
        ...req.body,
        idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
      },
      actorId: req.auth.sub,
    })
  ));
  router.post('/expenses', endpoint(
    'expense recording',
    (req) => service.createFinancialExpense({
      body: {
        ...req.body,
        idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
      },
      actorId: req.auth.sub,
    }),
    201
  ));
  router.post('/expenses/:expenseId/void', endpoint('expense correction', (req) =>
    service.voidFinancialExpense({
      expenseId: req.params.expenseId,
      body: {
        ...req.body,
        idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
      },
      actorId: req.auth.sub,
    })
  ));

  router.get('/snapshots/:month', endpoint('snapshot list', (req) =>
    service.getFinancialSnapshot(req.params.month)
  ));
  router.post('/snapshots/:month/prepare', endpoint('snapshot preparation', (req) =>
    service.prepareFinancialSnapshot({ month: req.params.month, actorId: req.auth.sub })
  ));
  router.post('/snapshots/versions/:versionId/finalize', endpoint('snapshot finalization', (req) =>
    service.finalizeFinancialSnapshot({
      versionId: req.params.versionId,
      body: req.body,
      actorId: req.auth.sub,
    })
  ));
  router.get('/audit', endpoint('audit log list', () =>
    service.listFinancialAuditLogs()
  ));

  return router;
};

export const financialRouter = createFinancialRouter();
