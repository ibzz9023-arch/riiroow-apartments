import React, { useEffect, useRef, useState } from 'react';
import { supabase, hasSupabase } from './supabaseClient';
import QRCode from 'qrcode';


const formatCurrency = (value) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

const formatDateTime = (value) => {
  if (!value) return '—';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};
const initialLogin = { email: 'admin@riiroow.com', password: 'admin123' };

const todayIso = () => new Date().toISOString().slice(0, 10);

const emptyUnitForm = {
  unitNumber: '',
  floor: '1',
  bedrooms: '2',
  bathrooms: '2',
  rent: '',
  status: 'occupied',
  occupancy: 'Occupied',
};

const emptyTenantForm = {
  name: '',
  email: '',
  phone: '',
  unitId: '',
  unitNumber: '',
  moveInDate: '',
  status: 'Active',
};

const emptyLeaseForm = {
  tenantId: '',
  unitId: '',
  unitNumber: '',
  startDate: todayIso(),
  endDate: '',
  monthlyRent: '',
  securityDeposit: '',
  status: 'Active',
  notes: '',
};

const emptyPaymentForm = {
  tenantId: '',
  unitId: '',
  unitNumber: '',
  amount: '',
  paidAmount: '',
  dueDate: new Date().toISOString().slice(0, 10),
  paidDate: '',
  status: 'Outstanding',
  method: 'ACH',
  notes: '',
};

const emptyMaintenanceForm = {
  unitNumber: '',
  title: '',
  description: '',
  priority: 'Medium',
  status: 'Pending',
  assignedTechnician: '',
  requestDate: todayIso(),
  dueDate: '',
  completionDate: '',
  reminderAt: '',
  notes: '',
};

const getStatusClass = (status = '') => {
    
  const value = String(status).trim().toLowerCase();

  if (!value) return 'neutral';
  if (value.includes('occupied')) return 'occupied';
  if (value.includes('vacant')) return 'vacant';
  if (value.includes('paid')) return 'paid';
  if (value.includes('overdue')) return 'overdue';
  if (value.includes('outstanding')) return 'overdue';
  if (value.includes('maintenance') || value.includes('emergency')) return 'maintenance';
  if (value.includes('in progress')) return 'in-progress';
  if (value.includes('scheduled')) return 'scheduled';
  if (value.includes('completed') || value.includes('resolved')) return 'resolved';
  if (value.includes('active')) return 'active';
  if (value.includes('inactive')) return 'inactive';
  if (value.includes('pending')) return 'pending';

  return 'neutral';
};

const getLeaseExpirationLabel = (endDate, status = '') => {
  const normalizedStatus = String(status).trim().toLowerCase();

  if (normalizedStatus === 'terminated') return 'Terminated';
  if (normalizedStatus === 'expired') return 'Expired';
  if (!endDate) return 'No end date';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const end = new Date(`${String(endDate).slice(0, 10)}T00:00:00`);

  if (Number.isNaN(end.getTime())) return '—';

  const difference = Math.ceil((end - today) / (1000 * 60 * 60 * 24));

  if (difference < 0) return 'Expired';
  if (difference === 0) return 'Expires today';
  if (difference === 1) return '1 day';
  return `${difference} days`;
};

function DashboardLoading() {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <div className="loading-spinner" aria-hidden="true" />
      <div>
        <strong>Loading dashboard</strong>
        <p>Gathering occupancy, rent, and maintenance details…</p>
      </div>
    </div>
  );
}

function EmptyState({ title, message }) {
  return (
    <div className="empty-state" role="status" aria-live="polite">
      <h4>{title}</h4>
      <p>{message}</p>
    </div>
  );
}



class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('Riiroow React render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px', fontFamily: 'sans-serif' }}>
          <h2>Riiroow encountered a display error</h2>
          <p>{this.state.error?.message || 'Unknown React error'}</p>
          <button onClick={() => window.location.reload()}>
            Reload Riiroow
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
const [user, setUser] = useState(null);
  const [token, setToken] = useState('');
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [activeTab, setActiveTab] = useState('overview');
  const [editingUnitId, setEditingUnitId] = useState(null);
  const [editingTenantId, setEditingTenantId] = useState(null);
  const [editingLeaseId, setEditingLeaseId] = useState(null);
  const [editingPaymentId, setEditingPaymentId] = useState(null);
  const [editingMaintenanceId, setEditingMaintenanceId] = useState(null);
  const [selectedTenantPayments, setSelectedTenantPayments] = useState(null);
  const [unitForm, setUnitForm] = useState(emptyUnitForm);
  const [tenantForm, setTenantForm] = useState(emptyTenantForm);
  const [leaseForm, setLeaseForm] = useState(emptyLeaseForm);
  const [paymentForm, setPaymentForm] = useState(emptyPaymentForm);
  const [maintenanceForm, setMaintenanceForm] = useState(emptyMaintenanceForm);
  const [depositOverview, setDepositOverview] = useState({ agreedDeposit: 0, depositReceived: 0, outstandingDeposit: 0, availableDeposit: 0, transactions: [], loaded: false });
  const [selectedDepositLeaseId, setSelectedDepositLeaseId] = useState('');
  const [depositSummary, setDepositSummary] = useState(null);
  const [depositLoading, setDepositLoading] = useState(false);
  const [depositForm, setDepositForm] = useState({
    type: 'payment',
    amount: '',
    transactionDate: todayIso(),
    notes: '',
  });

  const [qrMaintenanceOpen, setQrMaintenanceOpen] = useState(false);
  const [qrMaintenanceSubmitting, setQrMaintenanceSubmitting] = useState(false);
  const [qrPaymentVerificationOpen, setQrPaymentVerificationOpen] = useState(false);
  const [qrPaymentPin, setQrPaymentPin] = useState('');
  const [qrPaymentPinError, setQrPaymentPinError] = useState('');
  const [qrPaymentVerified, setQrPaymentVerified] = useState(false);
  const [qrTenantToken, setQrTenantToken] = useState('');
  const [qrMaintenanceForm, setQrMaintenanceForm] = useState({
    title: '',
    description: '',
    priority: 'Medium',
  });
  const [qrRecording, setQrRecording] = useState(false);
  const [qrAudioBlob, setQrAudioBlob] = useState(null);
  const [qrAudioUrl, setQrAudioUrl] = useState('');
  const [qrMediaError, setQrMediaError] = useState('');
  const qrMediaRecorderRef = useRef(null);
  const qrAudioChunksRef = useRef([]);

  const startQrVoiceRecording = async () => {
    setQrMediaError('');

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setQrMediaError('Voice recording is not supported by this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const supportedMimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg',
      ];

      const mimeType = supportedMimeTypes.find((type) =>
        MediaRecorder.isTypeSupported(type)
      );

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      qrAudioChunksRef.current = [];
      qrMediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          qrAudioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const actualMimeType = recorder.mimeType || mimeType || 'audio/webm';
        const audioBlob = new Blob(qrAudioChunksRef.current, {
          type: actualMimeType,
        });

        const audioUrl = URL.createObjectURL(audioBlob);

        setQrAudioBlob(audioBlob);
        setQrAudioUrl((previousUrl) => {
          if (previousUrl) URL.revokeObjectURL(previousUrl);
          return audioUrl;
        });
        setQrRecording(false);

        stream.getTracks().forEach((track) => track.stop());
        qrMediaRecorderRef.current = null;
        qrAudioChunksRef.current = [];
      };

      recorder.onerror = () => {
        setQrMediaError('Unable to record the voice report.');
        setQrRecording(false);
        stream.getTracks().forEach((track) => track.stop());
        qrMediaRecorderRef.current = null;
      };

      recorder.start();
      setQrRecording(true);
    } catch (error) {
      console.error('QR voice recording error:', error);
      setQrMediaError(
        error?.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Please allow microphone access and try again.'
          : 'Unable to access the microphone.'
      );
      setQrRecording(false);
    }
  };

  const stopQrVoiceRecording = () => {
    const recorder = qrMediaRecorderRef.current;

    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  };

  const discardQrVoiceRecording = () => {
    if (qrMediaRecorderRef.current) {
      if (qrMediaRecorderRef.current.state !== 'inactive') {
        qrMediaRecorderRef.current.stop();
      }
      qrMediaRecorderRef.current = null;
    }

    if (qrAudioUrl) {
      URL.revokeObjectURL(qrAudioUrl);
    }

    setQrAudioUrl('');
    setQrAudioBlob(null);
    setQrRecording(false);
    setQrMediaError('');
    qrAudioChunksRef.current = [];
  };
  const qrPathMatch = window.location.pathname.match(/\/qr\/([^/]+)/i);
  const qrUnitNumber = qrPathMatch ? decodeURIComponent(qrPathMatch[1]) : '';


  const requestJson = async (path, options = {}) => {
    const { method = 'GET', body, headers = {} } = options;
    const apiBaseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

    const response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: {
        ...(body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body
        ? { body: isFormData ? body : JSON.stringify(body) }
        : {}),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Request failed.');
    }

    return data;
  };
    const viewMaintenanceEvidence = async (item) => {
    const popup = window.open('', '_blank');

    if (!popup) {
      setError('Please allow pop-ups to view maintenance attachments.');
      return;
    }

    popup.document.title = 'Maintenance attachments';
    popup.document.body.innerHTML =
      '<p style="font-family:Arial;padding:24px">Loading attachments...</p>';

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[char]);

    try {
      const result = await requestJson(
        `/api/maintenance/${encodeURIComponent(item.id)}/evidence`
      );
      const files = result.evidence || [];

      if (!files.length) {
        popup.document.body.innerHTML =
          '<p style="font-family:Arial;padding:24px">No attachments were found for this maintenance request.</p>';
        return;
      }

      const cards = files.map((file) => {
        const name = escapeHtml(file.originalName || file.fileType || 'Attachment');
        const url = escapeHtml(file.url || '');
        const type = String(file.mimeType || '').toLowerCase();

        let media = '';

        if (type.startsWith('image/')) {
          media = `<img src="${url}" alt="${name}" style="max-width:100%;max-height:70vh;object-fit:contain">`;
        } else if (type.startsWith('audio/')) {
          media = `<audio controls preload="metadata" src="${url}" style="width:100%"></audio>`;
        } else if (type.startsWith('video/')) {
          media = `<video controls preload="metadata" src="${url}" style="max-width:100%;max-height:70vh"></video>`;
        } else {
          media = `<a href="${url}" target="_blank" rel="noopener noreferrer">Open attachment</a>`;
        }

        const size = Number(file.fileSize) > 0
          ? `<p>${(Number(file.fileSize) / 1024).toFixed(1)} KB</p>`
          : '';

        return `<section style="border:1px solid #ddd;border-radius:10px;padding:16px;margin:16px 0;overflow-wrap:anywhere"><h3>${name}</h3>${media}${size}</section>`;
      }).join('');

      popup.document.open();
      popup.document.write(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maintenance attachments</title></head><body style="font-family:Arial,sans-serif;max-width:900px;margin:24px auto;padding:0 16px"><h1>Maintenance attachments</h1><p>Request: ${escapeHtml(item.title || item.description || item.id)}</p>${cards}<p>Secure attachment links expire after 10 minutes.</p></body></html>`
      );
      popup.document.close();
    } catch (err) {
      popup.document.body.innerHTML = '';
      const message = popup.document.createElement('p');
      message.style.cssText = 'font-family:Arial;padding:24px';
      message.textContent = err.message || 'Unable to load maintenance attachments.';
      popup.document.body.appendChild(message);
    }
  };
const printUnitQRCodes = async () => {
    if (!units.length) {
      window.alert('No units are available to print QR codes.');
      return;
    }

    const printWindow = window.open('', '_blank', 'width=1000,height=800');
    if (!printWindow) {
      window.alert('Please allow pop-ups for Riiroow to print QR codes.');
      return;
    }

    printWindow.document.write(`
      <!doctype html>
      <html>
        <head>
          <title>Riiroow Unit QR Codes</title>
          <style>
            @page {
              size: A4;
              margin: 12mm;
            }

            * {
              box-sizing: border-box;
            }

            body {
              margin: 0;
              font-family: Arial, sans-serif;
              background: #fff;
              color: #171717;
            }

            .qr-page {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 12mm;
            }

            .qr-card {
              border: 2px solid #171717;
              border-radius: 12px;
              min-height: 115mm;
              padding: 10mm;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              text-align: center;
              break-inside: avoid;
              page-break-inside: avoid;
            }

            .brand {
              font-size: 20px;
              font-weight: 800;
              letter-spacing: 2px;
              margin-bottom: 5mm;
            }

            .qr-label {
              font-size: 28px;
              font-weight: 800;
              margin-bottom: 2mm;
            }

            .unit-label {
              font-size: 18px;
              font-weight: 600;
              margin-bottom: 6mm;
            }

            .qr-image {
              width: 58mm;
              height: 58mm;
              image-rendering: pixelated;
            }

            .pin-label {
              font-size: 24px;
              font-weight: 900;
              margin-top: 5mm;
              padding: 3mm 5mm;
              border: 2px dashed #171717;
            }

            .instructions {
              margin-top: 6mm;
              font-size: 11px;
              line-height: 1.4;
              max-width: 65mm;
            }

            @media print {
              .qr-card {
                box-shadow: none;
              }
            }
          </style>
        </head>
        <body>
          <div class="qr-page" id="qr-page"></div>
        </body>
      </html>
    `);
    printWindow.document.close();

    const page = printWindow.document.getElementById('qr-page');

    for (const unit of units) {
      const unitNumber = String(unit.unitNumber || '').trim();
      const qrData = `https://riiroow-apartments-production.up.railway.app/qr/${encodeURIComponent(unitNumber)}`;

      const qrDataUrl = await QRCode.toDataURL(qrData, {
        width: 500,
        margin: 2,
        errorCorrectionLevel: 'H',
      });

      const card = printWindow.document.createElement('div');
      card.className = 'qr-card';
      card.innerHTML = `
        <div class="brand">RIIROOW</div>
        <div class="qr-label">QR ${unitNumber}</div>
        <div class="unit-label">UNIT ${unitNumber}</div>
        <img class="qr-image" src="${qrDataUrl}" alt="QR code for unit ${unitNumber}" />
        <div class="pin-label">TENANT PIN: ${String(unitNumber).padStart(4, '0')}</div>
        <div class="instructions">
          Scan this code for Riiroow apartment services.
        </div>
      `;

      page.appendChild(card);
    }

    printWindow.focus();
    setTimeout(() => printWindow.print(), 300);
  };

  const loadSecurityDeposit = async (leaseId) => {
    if (!leaseId) {
      setDepositSummary(null);
      return;
    }

    setDepositLoading(true);
    setError('');

    try {
      const summary = await requestJson(
        `/api/leases/${encodeURIComponent(leaseId)}/security-deposits`
      );
      setDepositSummary(summary);
    } catch (err) {
      setError(err.message || 'Unable to load security-deposit records.');
    } finally {
      setDepositLoading(false);
    }
  };

  const handleDepositSubmit = async (event) => {
    event.preventDefault();

    if (!selectedDepositLeaseId) {
      setError('Please select a lease first.');
      return;
    }

    const amount = Number(depositForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }

    setDepositLoading(true);
    setError('');
    setInfoMessage('');

    try {
      await requestJson(
        `/api/leases/${encodeURIComponent(selectedDepositLeaseId)}/security-deposits`,
        {
          method: 'POST',
          body: {
            transactionType: depositForm.type,
            amount,
            transactionDate: depositForm.transactionDate,
            notes: depositForm.notes,
          },
        }
      );

      const summary = await requestJson(
        `/api/leases/${encodeURIComponent(selectedDepositLeaseId)}/security-deposits`
      );
      setDepositSummary(summary);
      setDepositForm({
        type: 'payment',
        amount: '',
        transactionDate: todayIso(),
        notes: '',
      });
      setInfoMessage('Security-deposit transaction recorded successfully.');

      // Refresh dashboard totals without changing existing records.
      await fetchDashboard();
    } catch (err) {
      setError(err.message || 'Unable to record the security-deposit transaction.');
    } finally {
      setDepositLoading(false);
    }
  };
  const handleQrMaintenanceSubmit = async (event) => {
    event.preventDefault();

    if (!qrTenantToken) {
      setError('Verify your tenant PIN before submitting a maintenance request.');
      return;
    }

    const form = event.currentTarget;
    const payload = new FormData(form);
    const title = String(payload.get('title') || '').trim();
    const description = String(payload.get('description') || '').trim();

    if (qrAudioBlob) {
      const audioExtension = qrAudioBlob.type.includes('ogg') ? 'ogg' : 'webm';
      payload.append('audio', qrAudioBlob, 'voice-report.' + audioExtension);
    }

    const hasMedia = ['audio', 'photo', 'video'].some((field) => {
      const file = payload.get(field);
      return file && typeof file === 'object' && file.size > 0;
    });

    if (!title && !description && !hasMedia) {
      setError('Describe the problem or attach a voice recording, photo, or video.');
      return;
    }

    setError('');
    setInfoMessage('');
    setQrMaintenanceSubmitting(true);

    try {
      const response = await requestJson(
        `/api/public/qr/${encodeURIComponent(qrUnitNumber)}/maintenance`,
        {
          method: 'POST',
          body: payload,
          headers: { Authorization: `Bearer ${qrTenantToken}` },
        }
      );

      setInfoMessage(
        response.message || 'Maintenance request submitted successfully.'
      );

      setQrMaintenanceForm({
        title: '',
        description: '',
        priority: 'Medium',
      });

      form.reset();

      if (qrAudioUrl) {
        URL.revokeObjectURL(qrAudioUrl);
      }

      setQrAudioUrl('');
      setQrAudioBlob(null);
      setQrMediaError('');
      setQrMaintenanceOpen(false);
    } catch (requestError) {
      setError(
        requestError.message || 'Unable to submit the maintenance request.'
      );
    } finally {
      setQrMaintenanceSubmitting(false);
    }
  };

  const handleQrPaymentPinSubmit = async (event) => {
    event.preventDefault();

    const enteredPin = qrPaymentPin.trim();

    if (!/^\d{4}$/.test(enteredPin)) {
      setQrPaymentPinError('Enter your tenant PIN.');
      setQrPaymentVerified(false);
      setQrTenantToken('');
      return;
    }

    setQrPaymentPinError('');
    setQrPaymentVerified(false);
    setQrTenantToken('');

    try {
      const response = await requestJson(
        `/api/public/qr/${encodeURIComponent(qrUnitNumber)}/verify-pin`,
        {
          method: 'POST',
          body: { pin: enteredPin },
          headers: { Authorization: '' },
        }
      );

      if (!response.token) {
        throw new Error('Verification did not return a tenant session. Please try again.');
      }

      setQrTenantToken(response.token);
      setQrPaymentPin('');
      setQrPaymentPinError('');
      setQrPaymentVerified(true);
    } catch (requestError) {
      setQrPaymentPinError(
        requestError.message || 'Unable to verify your PIN. Please try again.'
      );
      setQrPaymentVerified(false);
      setQrTenantToken('');
    }
  };

  const fetchDashboard = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await requestJson('/api/dashboard');
      setDashboard(data);

      const leaseList = Array.isArray(data?.leases) ? data.leases : [];
      const depositResults = await Promise.all(
        leaseList.filter((lease) => lease?.id).map(async (lease) => {
          try {
            const summary = await requestJson(
              `/api/leases/${encodeURIComponent(lease.id)}/security-deposits`
            );
            return { lease, summary };
          } catch (depositError) {
            console.error(
              `Unable to load security deposit summary for lease ${lease.id}:`,
              depositError.message
            );
            return null;
          }
        })
      );

      const validDeposits = depositResults.filter(Boolean);
      const depositTotal = (field) => validDeposits.reduce(
        (total, item) => total + (Number(item.summary?.[field]) || 0),
        0
      );

      const depositTransactions = validDeposits.flatMap(({ lease, summary }) =>
        (Array.isArray(summary.transactions) ? summary.transactions : []).map((transaction) => ({
          ...transaction,
          leaseId: lease.id,
          unitNumber: lease.unitNumber ?? lease.unit_number ?? '',
          tenantName: lease.tenantName ?? lease.tenant_name ?? '',
        }))
      );

      setDepositOverview({
        agreedDeposit: depositTotal('agreedDeposit'),
        depositReceived: depositTotal('depositReceived'),
        outstandingDeposit: depositTotal('outstandingDeposit'),
        availableDeposit: depositTotal('availableDeposit'),
        transactions: depositTransactions,
        loaded: true,
      });      setDashboard(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const exportReportsToExcel = async () => {
    if (!dashboard) return;

    setError('');
    setInfoMessage('');

    try {
      const { createReportWorkbook } = await import('./reportExport.js');
      const workbook = await createReportWorkbook(dashboard);
      const blob = new Blob([workbook], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const downloadUrl = URL.createObjectURL(blob);
      const downloadLink = document.createElement('a');
      downloadLink.href = downloadUrl;
      downloadLink.download = `riiroow-report-${todayIso()}.xlsx`;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      setInfoMessage('Excel report downloaded.');
    } catch {
      setError('Unable to export the report. Please try again.');
    }
  };

  const exportPaymentsToExcel = async () => {
    if (!dashboard) return;

    setError('');
    setInfoMessage('');

    try {
      const { createPaymentLedgerWorkbook } = await import('./reportExport.js');
      const workbook = await createPaymentLedgerWorkbook(dashboard);
      const blob = new Blob([workbook], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const downloadUrl = URL.createObjectURL(blob);
      const downloadLink = document.createElement('a');
      downloadLink.href = downloadUrl;
      downloadLink.download = `riiroow-payment-ledger-${todayIso()}.xlsx`;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      setInfoMessage('Payment ledger downloaded.');
    } catch {
      setError('Unable to export the payment ledger. Please try again.');
    }
  };

  useEffect(() => {
    if (token) {
      fetchDashboard();
    } else {
      setLoading(false);
    }
  }, [token]);



const handleLogin = async (event) => {
    event.preventDefault();
    setError('');
    setInfoMessage('');

    try {
      const formData = new FormData(event.currentTarget);
      const email = String(formData.get('email') || '').trim().toLowerCase();
      const password = String(formData.get('password') || '').trim();

      const data = await requestJson('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      });

      setUser(data.user);
      setToken(data.token);
      setActiveTab('overview');
    } catch (err) {
      setError(err.message);
    }
  };

  const handleUnitSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setInfoMessage('');

    try {
      const payload = {
        unitNumber: Number(unitForm.unitNumber),
        floor: Number(unitForm.floor),
        bedrooms: Number(unitForm.bedrooms),
        bathrooms: Number(unitForm.bathrooms || 1),
        rent: Number(unitForm.rent),
        status: unitForm.status,
        occupancy: unitForm.occupancy,
      };

      if (!payload.unitNumber || !payload.rent) {
        throw new Error('Unit number and rent are required.');
      }

      if (editingUnitId) {
        await requestJson(`/api/units/${editingUnitId}`, {
          method: 'PATCH',
          body: payload,
        });
        setInfoMessage('Unit updated successfully.');
      } else {
        await requestJson('/api/units', {
          method: 'POST',
          body: payload,
        });
        setInfoMessage('Unit added successfully.');
      }

      setUnitForm(emptyUnitForm);
      setEditingUnitId(null);
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleTenantSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setInfoMessage('');

    try {
      const payload = {
        name: tenantForm.name,
        email: tenantForm.email,
        phone: tenantForm.phone,
        unitId: tenantForm.unitId,
        unitNumber: Number(tenantForm.unitNumber),
        moveInDate: tenantForm.moveInDate || todayIso(),
        status: tenantForm.status,
      };

      if (!payload.name || !payload.unitId || !payload.unitNumber) {
        throw new Error('Tenant name and unit are required.');
      }

      if (editingTenantId) {
        await requestJson(`/api/tenants/${editingTenantId}`, {
          method: 'PATCH',
          body: payload,
        });
        setInfoMessage('Tenant updated successfully.');
      } else {
        await requestJson('/api/tenants', {
          method: 'POST',
          body: payload,
        });
        setInfoMessage('Tenant added successfully.');
      }

      setTenantForm(emptyTenantForm);
      setEditingTenantId(null);
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleLeaseSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setInfoMessage('');

    try {
      const body = {
        tenantId: leaseForm.tenantId,
        unitId: leaseForm.unitId || null,
        unitNumber: Number(leaseForm.unitNumber),
        startDate: leaseForm.startDate,
        endDate: leaseForm.endDate || null,
        monthlyRent: Number(leaseForm.monthlyRent || 0),
        securityDeposit: Number(leaseForm.securityDeposit || 0),
        status: leaseForm.status,
        notes: leaseForm.notes,
      };

      if (editingLeaseId) {
        await requestJson(`/api/leases/${editingLeaseId}`, {
          method: 'PATCH',
          body,
        });
        setInfoMessage('Lease updated successfully.');
      } else {
        await requestJson('/api/leases', {
          method: 'POST',
          body,
        });
        setInfoMessage('Lease created successfully.');
      }

      setLeaseForm(emptyLeaseForm);
      setEditingLeaseId(null);
      await fetchDashboard();
    } catch (submitError) {
      setError(submitError.message);
    }
  };

  const handleGenerateTenantPin = async (lease) => {
    if (String(lease.status).toLowerCase() !== 'active') {
      window.alert('A tenant PIN can only be generated for an active lease.');
      return;
    }

    const typedUnitNumber = window.prompt(
      `Safety check: type ${lease.unitNumber} to confirm the correct unit.`,
      ''
    );

    if (typedUnitNumber === null) return;

    if (typedUnitNumber.trim() !== String(lease.unitNumber).trim()) {
      window.alert('Unit number did not match. No PIN was changed.');
      return;
    }

    const confirmed = window.confirm(
      `FINAL CONFIRMATION: Generate or reset the PIN for Unit ${lease.unitNumber}? Existing PIN access will be reset.`
    );

    if (!confirmed) return;

    setError('');
    setInfoMessage('');

    try {
      const response = await requestJson(
        `/api/manager/leases/${encodeURIComponent(lease.id)}/tenant-pin`,
        {
          method: 'POST',
          body: { expectedUnitNumber: typedUnitNumber.trim() },
        }
      );

      if (
        String(response.unitNumber) !== typedUnitNumber.trim() ||
        String(response.pin || '') !== String(lease.unitNumber).padStart(4, '0') ||
        !/^\d{4}$/.test(String(response.pin || ''))
      ) {
        throw new Error(
          'Safety check failed: the server returned a different unit. Do not share a PIN.'
        );
      }

      window.alert(
        `NEW TENANT PIN — UNIT ${lease.unitNumber}\n\n` +
        `${response.pin}\n\n` +
        'Give this PIN directly to the authorized tenant. ' +
        'It will not be shown again. Do not share it publicly.'
      );

      setInfoMessage(
        `A new tenant PIN was generated for Unit ${lease.unitNumber}. Share it privately with the authorized tenant.`
      );
    } catch (requestError) {
      setError(requestError.message || 'Unable to generate the tenant PIN.');
    }
  };

  const handleTerminateLease = async (lease) => {
    const confirmed = window.confirm(
      `Terminate lease ${lease.id} for unit ${lease.unitNumber}?`
    );

    if (!confirmed) return;

    setError('');
    setInfoMessage('');

    try {
      await requestJson(`/api/leases/${lease.id}`, {
        method: 'DELETE',
        body: { notes: 'Lease terminated from Lease Management.' },
      });

      setInfoMessage('Lease terminated successfully.');
      setLeaseForm(emptyLeaseForm);
      setEditingLeaseId(null);
      await fetchDashboard();
    } catch (terminateError) {
      setError(terminateError.message);
    }
  };

  const printPaymentReceipt = (payment) => {
    const tenant = tenants.find(
      (item) => String(item.id) === String(payment.tenantId)
    );

    const tenantName = tenant?.name || payment.tenantName || '—';
    const tenantEmail = tenant?.email || '—';
    const tenantPhone = tenant?.phone || '—';

    const printWindow = window.open('', '_blank', 'width=800,height=900');

    if (!printWindow) {
      setError('Please allow pop-ups to print the payment receipt.');
      return;
    }

    const safe = (value) =>
      String(value ?? '—')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const amountDue = formatCurrency(payment.amount);
    const amountPaid = formatCurrency(payment.paidAmount);
    const remaining = formatCurrency(payment.remainingAmount);

    printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Riiroow Payment Receipt - ${safe(payment.id)}</title>
  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 32px;
      background: #fff;
      color: #171717;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 14px;
    }

    .receipt {
      width: 100%;
      max-width: 760px;
      margin: 0 auto;
      border: 1px solid #d6d3d1;
      padding: 34px;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      border-bottom: 2px solid #171717;
      padding-bottom: 20px;
      margin-bottom: 24px;
    }

    .brand {
      font-size: 27px;
      font-weight: 800;
      letter-spacing: 1.5px;
      margin: 0;
    }

    .subtitle {
      margin-top: 6px;
      color: #666;
      font-size: 12px;
      letter-spacing: 1px;
      text-transform: uppercase;
    }

    .receipt-title {
      text-align: right;
      font-size: 20px;
      font-weight: 700;
    }

    .receipt-id {
      margin-top: 7px;
      color: #666;
      font-size: 11px;
      word-break: break-all;
    }

    h2 {
      font-size: 15px;
      margin: 24px 0 12px;
      padding-bottom: 7px;
      border-bottom: 1px solid #ddd;
    }

    .details {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px 28px;
    }

    .detail {
      line-height: 1.5;
    }

    .label {
      color: #666;
      font-size: 11px;
      text-transform: uppercase;
      display: block;
      margin-bottom: 2px;
    }

    .amount-box {
      margin-top: 18px;
      border: 1px solid #d6d3d1;
      padding: 18px;
    }

    .amount-row {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      padding: 8px 0;
    }

    .amount-row.total {
      border-top: 2px solid #171717;
      margin-top: 7px;
      padding-top: 13px;
      font-size: 17px;
      font-weight: 800;
    }

    .status {
      font-weight: 700;
    }

    .notes {
      background: #f7f7f6;
      border: 1px solid #e5e5e5;
      padding: 12px;
      min-height: 45px;
      white-space: pre-wrap;
    }

    .footer {
      margin-top: 38px;
      padding-top: 16px;
      border-top: 1px solid #ccc;
      text-align: center;
      color: #666;
      font-size: 11px;
      line-height: 1.6;
    }

    .signature {
      margin-top: 48px;
      width: 260px;
      border-top: 1px solid #222;
      padding-top: 8px;
    }

    @media print {
      body {
        padding: 0;
      }

      .receipt {
        max-width: none;
        border: none;
        padding: 0;
      }

      .no-print {
        display: none;
      }
    }
  </style>
</head>

<body>
  <div class="receipt">
    <div class="header">
      <div>
        <div class="brand">RIIROOW APARTMENT</div>
        <div class="subtitle">Apartment Management</div>
      </div>
      <div>
        <div class="receipt-title">PAYMENT RECEIPT</div>
        <div class="receipt-id">Receipt ID: ${safe(payment.id)}</div>
      </div>
    </div>

    <h2>Tenant Information</h2>
    <div class="details">
      <div class="detail">
        <span class="label">Tenant Name</span>
        ${safe(tenantName)}
      </div>
      <div class="detail">
        <span class="label">Unit</span>
        ${safe(payment.unitNumber ? `Unit ${payment.unitNumber}` : '—')}
      </div>
      <div class="detail">
        <span class="label">Phone</span>
        ${safe(tenantPhone)}
      </div>
      <div class="detail">
        <span class="label">Email</span>
        ${safe(tenantEmail)}
      </div>
    </div>

    <h2>Payment Information</h2>
    <div class="details">
      <div class="detail">
        <span class="label">Due Date</span>
        ${safe(payment.dueDate)}
      </div>
      <div class="detail">
        <span class="label">Paid Date</span>
        ${safe(payment.paidDate || '—')}
      </div>
      <div class="detail">
        <span class="label">Payment Method</span>
        ${safe(payment.method || '—')}
      </div>
      <div class="detail">
        <span class="label">Status</span>
        <span class="status">${safe(payment.status || '—')}</span>
      </div>
    </div>

    <div class="amount-box">
      <div class="amount-row">
        <span>Amount Due</span>
        <strong>${safe(amountDue)}</strong>
      </div>
      <div class="amount-row">
        <span>Amount Paid</span>
        <strong>${safe(amountPaid)}</strong>
      </div>
      <div class="amount-row total">
        <span>Remaining Balance</span>
        <strong>${safe(remaining)}</strong>
      </div>
    </div>

    <h2>Notes</h2>
    <div class="notes">${safe(payment.notes || 'No additional notes.')}</div>

    <div class="signature">
      <strong>Riiroow Apartment Management</strong><br />
      Authorized Signature
    </div>

    <div class="footer">
      Riiroow Apartment Management<br />
      Payment receipt generated from the Riiroow property management system.
    </div>
  </div>
</body>
</html>`);

    printWindow.document.close();
    printWindow.focus();

    setTimeout(() => {
      printWindow.print();
    }, 300);
  };

  const printLease = (lease) => {
    const tenant = tenants.find(
      (item) => String(item.id) === String(lease.tenantId)
    );

    const tenantName = tenant?.name || lease.tenantId || '—';
    const tenantEmail = tenant?.email || '—';
    const tenantPhone = tenant?.phone || '—';

    const printWindow = window.open('', '_blank', 'width=900,height=1000');

    if (!printWindow) {
      setError('Please allow pop-ups to print the lease document.');
      return;
    }

    const safe = (value) =>
      String(value ?? '—')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const monthlyRent = formatCurrency(lease.monthlyRent);
    const securityDeposit = formatCurrency(lease.securityDeposit);

    printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Riiroow Lease Agreement - ${safe(lease.id)}</title>
  <style>
    @page {
      size: A4;
      margin: 18mm;
    }

    * {
      box-sizing: border-box;
    }

    body {
      font-family: Arial, Helvetica, sans-serif;
      color: #222;
      max-width: 850px;
      margin: 0 auto;
      padding: 0;
      line-height: 1.5;
      font-size: 13px;
    }

    .header {
      text-align: center;
      border-bottom: 3px solid #222;
      padding-bottom: 14px;
      margin-bottom: 20px;
    }

    .brand-logo {
      width: 180px;
      height: 78px;
      margin: 0 auto 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .brand-logo img {
      display: block;
      width: auto;
      height: auto;
      max-width: 180px;
      max-height: 78px;
      object-fit: contain;
    }

    .brand {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 1px;
      margin: 0;
    }

    .subtitle {
      font-size: 18px;
      margin: 5px 0;
      font-weight: 600;
    }

    .lease-id {
      font-size: 12px;
      color: #666;
      margin-top: 8px;
    }

    h2 {
      font-size: 17px;
      margin-top: 25px;
      margin-bottom: 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid #bbb;
    }

    .details {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 35px;
    }

    .detail {
      padding: 8px 0;
      border-bottom: 1px solid #eee;
    }

    .label {
      font-weight: 700;
    }

    .clause {
      margin: 10px 0;
    }

    .notes {
      min-height: 70px;
      border: 1px solid #ccc;
      padding: 12px;
      white-space: pre-wrap;
    }

    .signatures {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 30px;
      margin-top: 55px;
      align-items: end;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .signature {
      border-top: 1px solid #222;
      padding-top: 8px;
      min-height: 100px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .lease-signature-image {
      display: block;
      width: 260px;
      max-width: 100%;
      height: 85px;
      object-fit: contain;
      object-position: left center;
      margin: -8px 0 0;
    }

    .footer {
      margin-top: 45px;
      padding-top: 12px;
      border-top: 1px solid #ccc;
      text-align: center;
      font-size: 11px;
      color: #666;
    }

    .status {
      font-weight: 700;
    }

    @media print {
      body {
        padding: 0;
        margin: 0;
        max-width: none;
      }

      .brand-logo {
        width: 180px;
        height: 78px;
      }

      .brand-logo img {
        max-width: 180px;
        max-height: 78px;
      }

      .header,
      h2,
      .details,
      .notes,
      .signatures {
        break-inside: avoid;
      }

      .no-print {
        display: none;
      }
    }
  </style>
</head>

<body>
  <div class="header">
    <div class="brand-logo">
      <img src="${window.location.origin}${import.meta.env.BASE_URL}riiroow-logo.png" alt="Riiroow Apartments">
    </div>
    <h1 class="brand">RIIROOW APARTMENT</h1>
    <div class="subtitle">LEASE SUMMARY</div>
    <div class="lease-id">Lease ID: ${safe(lease.id)}</div>
  </div>

  <h2>1. Tenant Information</h2>
  <div class="details">
    <div class="detail">
      <span class="label">Tenant Name:</span> ${safe(tenantName)}
    </div>
    <div class="detail">
      <span class="label">Phone:</span> ${safe(tenantPhone)}
    </div>
    <div class="detail">
      <span class="label">Email:</span> ${safe(tenantEmail)}
    </div>
    <div class="detail">
      <span class="label">Unit Number:</span> ${safe(lease.unitNumber)}
    </div>
  </div>

  <h2>2. Lease Term</h2>
  <div class="details">
    <div class="detail">
      <span class="label">Start Date:</span> ${safe(lease.startDate)}
    </div>
    <div class="detail">
      <span class="label">End Date:</span> ${safe(lease.endDate)}
    </div>
    <div class="detail">
      <span class="label">Lease Status:</span>
      <span class="status">${safe(lease.status)}</span>
    </div>
    <div class="detail">
      <span class="label">Unit:</span> ${safe(lease.unitNumber)}
    </div>
  </div>

  <h2>3. Rent and Security Deposit</h2>
  <div class="details">
    <div class="detail">
      <span class="label">Monthly Rent:</span> ${safe(monthlyRent)}
    </div>
    <div class="detail">
      <span class="label">Security Deposit:</span> ${safe(securityDeposit)}
    </div>
  </div>

  <h2>4. Additional Notes</h2>
  <div class="notes">${safe(lease.notes || 'No additional notes.')}</div>

  <div class="signatures">
    <div class="signature">
      <strong>Tenant Signature</strong><br><br>
      Name: ${safe(tenantName)}<br>
      Date: ____________________
    </div>

    <div class="signature authorized-signature">
      <strong>Riiroow Apartment Management</strong><br>
      Date: ____________________
    </div>
  </div>

  <div class="footer">
    Riiroow Apartment Management — Residential Lease Agreement
  </div>
</body>
</html>`);

    printWindow.document.close();
    printWindow.focus();

    setTimeout(() => {
      printWindow.print();
    }, 300);
  };

  const beginEditLease = (lease) => {
    setEditingLeaseId(lease.id);
    setLeaseForm({
      tenantId: lease.tenantId ?? '',
      unitId: lease.unitId ?? '',
      unitNumber: lease.unitNumber ?? '',
      startDate: lease.startDate ?? todayIso(),
      endDate: lease.endDate ?? '',
      monthlyRent: lease.monthlyRent ?? '',
      securityDeposit: lease.securityDeposit ?? '',
      status: lease.status ?? 'Active',
      notes: lease.notes ?? '',
    });
    setActiveTab('leases');
  };

  const cancelEditLease = () => {
    setEditingLeaseId(null);
    setLeaseForm(emptyLeaseForm);
  };

  const handleRenewLease = (lease) => {
    const currentEndDate = lease.endDate ? String(lease.endDate).slice(0, 10) : '';

    setEditingLeaseId(lease.id);
    setLeaseForm({
      tenantId: lease.tenantId ?? '',
      unitId: lease.unitId ?? '',
      unitNumber: lease.unitNumber ?? '',
      startDate: currentEndDate || todayIso(),
      endDate: '',
      monthlyRent: lease.monthlyRent ?? '',
      securityDeposit: lease.securityDeposit ?? '',
      status: 'Active',
      notes: `${lease.notes ? `${lease.notes} ` : ''}Lease renewed from ${currentEndDate || 'previous term'}.`,
    });
    setActiveTab('leases');
    setInfoMessage(`Renewing lease ${lease.id}. Enter the new end date and save.`);
  };


  const handlePaymentSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setInfoMessage('');

    try {
      const payload = {
        tenantId: paymentForm.tenantId,
        unitId: paymentForm.unitId,
        unitNumber: Number(paymentForm.unitNumber),
        amount: Number(paymentForm.amount),
        paidAmount: Number(paymentForm.paidAmount || 0),
        dueDate: paymentForm.dueDate,
        paidDate: paymentForm.paidDate || null,
        status: paymentForm.status,
        method: paymentForm.method,
        notes: paymentForm.notes,
      };

      if (!payload.tenantId || !payload.unitId || !payload.unitNumber || !payload.amount) {
        throw new Error('Tenant, unit, and amount are required.');
      }

      if (editingPaymentId) {
        await requestJson(`/api/payments/${editingPaymentId}`, {
          method: 'PATCH',
          body: payload,
        });
        setInfoMessage('Payment updated successfully.');
      } else {
        await requestJson('/api/payments', {
          method: 'POST',
          body: payload,
        });
        setInfoMessage('Payment entry created successfully.');
      }

      setPaymentForm(emptyPaymentForm);
      setEditingPaymentId(null);
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteUnit = async (unitId) => {
    if (!window.confirm('Delete this unit?')) return;
    try {
      await requestJson(`/api/units/${unitId}`, { method: 'DELETE' });
      setInfoMessage('Unit deleted.');
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteTenant = async (tenantId) => {
    if (!window.confirm('Delete this tenant?')) return;
    try {
      await requestJson(`/api/tenants/${tenantId}`, { method: 'DELETE' });
      setInfoMessage('Tenant deleted.');
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  const viewTenantPayments = async (tenant) => {
    try {
      setError('');
      setInfoMessage('');
      const data = await requestJson(`/api/tenants/${tenant.id}/payments`);
      setSelectedTenantPayments(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const deletePayment = async (paymentId) => {
    if (!window.confirm('Delete this payment record?')) return;
    try {
      await requestJson(`/api/payments/${paymentId}`, { method: 'DELETE' });
      setInfoMessage('Payment record deleted.');
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleMaintenanceSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setInfoMessage('');

    try {
      const payload = {
        unitNumber: Number(maintenanceForm.unitNumber),
        title: maintenanceForm.title,
        description: maintenanceForm.description,
        priority: maintenanceForm.priority,
        status: maintenanceForm.status,
        assignedTechnician: maintenanceForm.assignedTechnician,
        requestDate: maintenanceForm.requestDate || todayIso(),
        dueDate: maintenanceForm.dueDate || null,
        completionDate: maintenanceForm.completionDate || null,
        reminderAt: maintenanceForm.reminderAt || null,
        notes: maintenanceForm.notes,
      };

      if (!payload.unitNumber || !payload.title) {
        throw new Error('Unit number and request title are required.');
      }

      if (editingMaintenanceId) {
        await requestJson(`/api/maintenance/${editingMaintenanceId}`, {
          method: 'PATCH',
          body: payload,
        });
        setInfoMessage('Maintenance request updated successfully.');
      } else {
        await requestJson('/api/maintenance', {
          method: 'POST',
          body: payload,
        });
        setInfoMessage('Maintenance request created successfully.');
      }

      setMaintenanceForm(emptyMaintenanceForm);
      setEditingMaintenanceId(null);
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  const updateMaintenanceStatus = async (item, status) => {
    try {
      await requestJson(`/api/maintenance/${item.id}`, {
        method: 'PATCH',
        body: {
          unitNumber: Number(item.unitNumber),
          title: item.title,
          description: item.description || '',
          priority: item.priority,
          status,
          assignedTechnician: item.assignedTechnician || '',
          requestDate: item.requestDate || todayIso(),
          dueDate: item.dueDate || null,
          completionDate: status === 'Completed' ? (item.completionDate || todayIso()) : (item.completionDate || null),
          reminderAt: item.reminderAt || null,
          notes: item.notes || '',
        },
      });
      setInfoMessage(`Maintenance request marked ${status.toLowerCase()}.`);
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteMaintenance = async (maintenanceId) => {
    if (!window.confirm('Delete this maintenance request?')) return;
    try {
      await requestJson(`/api/maintenance/${maintenanceId}`, { method: 'DELETE' });
      setInfoMessage('Maintenance request deleted.');
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  if (qrUnitNumber) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="brand-header">
            <div className="brand-mark">
              <img src={import.meta.env.BASE_URL + 'riiroow-logo.png'} alt="Riiroow Apartments logo" />
            </div>
            <div className="brand-copy">
              <p className="eyebrow">Riiroow Apartments</p>
              <h1>Unit {qrUnitNumber}</h1>
            </div>
          </div>

          <div className="auth-intro">
            Welcome to Riiroow apartment services for Unit {qrUnitNumber}.
          </div>

          <div className="stacked-sections">
            <button
              type="button"
              className="primary-btn"
              onClick={() => setQrMaintenanceOpen(true)}
            >
              Maintenance Request
            </button>

            <button
              type="button"
              className="primary-btn"
              onClick={() => {
                setQrPaymentPin('');
                setQrPaymentPinError('');
                setQrPaymentVerified(false);
                setQrPaymentVerificationOpen(true);
              }}
            >
              Tenant PIN Verification
            </button>
          </div>

          {qrPaymentVerificationOpen ? (
            <section className="panel" style={{ marginTop: '16px', textAlign: 'left' }}>
              <div className="panel-header">
                <h3>Tenant PIN Verification</h3>
              </div>
              <form className="crud-form" onSubmit={handleQrPaymentPinSubmit}>
                <label>
                  Unit number PIN
                  <input
                    type="password"
                    name="pin"
                    value={qrPaymentPin}
                    onChange={(event) => {
                      setQrPaymentPin(event.target.value);
                      setQrPaymentPinError('');
                      setQrPaymentVerified(false);
                    }}
                    autoComplete="off"
                    maxLength={64}
                    aria-describedby="qr-payment-pin-note"
                  />
                </label>
                {qrPaymentPinError ? <p className="error-text" role="alert">{qrPaymentPinError}</p> : null}
                {qrPaymentVerified ? (
                  <p className="success-text" role="status">
                    Tenant PIN verified. Payment records and other private information are not available in this portal.
                  </p>
                ) : null}
                <p id="qr-payment-pin-note">
                  The unit number is guessable and is not strong authentication. This check does not grant access to private records.
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setQrPaymentVerificationOpen(false)}
                  >
                    Back
                  </button>
                  <button type="submit" className="primary-btn">Verify PIN</button>
                </div>
              </form>
            </section>
          ) : null}

          {qrMaintenanceOpen ? (
            <section className="panel" style={{ marginTop: '16px', textAlign: 'left' }}>
              <div className="panel-header">
                <h3>Report a maintenance problem</h3>
              </div>

              <form className="crud-form" onSubmit={handleQrMaintenanceSubmit}>
                <label>
                  What is the problem?
                  <input
                    type="text"
                    name="title"
                    value={qrMaintenanceForm.title}
                    onChange={(e) =>
                      setQrMaintenanceForm((current) => ({
                        ...current,
                        title: e.target.value,
                      }))
                    }
                    placeholder="Example: Water leak"
                    maxLength={200}
                  />
                </label>

                <label>
                  Details <span style={{ fontWeight: 400 }}>(optional)</span>
                  <textarea
                    name="description"
                    value={qrMaintenanceForm.description}
                    onChange={(e) =>
                      setQrMaintenanceForm((current) => ({
                        ...current,
                        description: e.target.value,
                      }))
                    }
                    placeholder="Describe what is happening..."
                    maxLength={5000}
                    rows={5}
                  />
                </label>

                <label>
                  Priority
                  <select
                    name="priority"
                    value={qrMaintenanceForm.priority}
                    onChange={(e) =>
                      setQrMaintenanceForm((current) => ({
                        ...current,
                        priority: e.target.value,
                      }))
                    }
                  >
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                    <option value="Emergency">Emergency</option>
                  </select>
                </label>

                <div style={{ display: 'grid', gap: '12px', marginTop: '8px' }}>
        <div>
          <strong>Voice report</strong>
          <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {!qrRecording ? (
              <button
                type="button"
                className="secondary-btn"
                onClick={startQrVoiceRecording}
              >
                {qrAudioBlob ? 'Record Again' : 'Record Voice'}
              </button>
            ) : (
              <button
                type="button"
                className="secondary-btn"
                onClick={stopQrVoiceRecording}
              >
                Stop Recording
              </button>
            )}

            {qrAudioBlob ? (
              <button
                type="button"
                className="secondary-btn"
                onClick={discardQrVoiceRecording}
              >
                Discard Recording
              </button>
            ) : null}
          </div>

          {qrAudioUrl ? (
            <audio
              controls
              src={qrAudioUrl}
              style={{ width: '100%', marginTop: '8px' }}
            />
          ) : null}
        </div>

        <label>
          Photo <span style={{ fontWeight: 400 }}>(optional)</span>
          <input
            type="file"
            name="photo"
            accept="image/*"
          />
        </label>

        <label>
          Video <span style={{ fontWeight: 400 }}>(optional)</span>
          <input
            type="file"
            name="video"
            accept="video/*"
          />
        </label>

        {qrMediaError ? (
          <div style={{ color: '#b42318', fontSize: '14px' }}>
            {qrMediaError}
          </div>
        ) : null}
      </div>

      <div className="form-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setQrMaintenanceOpen(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="primary-btn">
                    Submit Request
                  </button>
                </div>
              </form>
            </section>
          ) : null}
        </div>
      </div>
    );
  }


  if (!user) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="brand-header">
            <div className="brand-mark"><img src={`${import.meta.env.BASE_URL}riiroow-logo.png`} alt="Riiroow Apartments logo" /></div>
            <div className="brand-copy">
              <p className="eyebrow">Property Management</p>
              <h1>Riiroow Apartments</h1>
            </div>
          </div>

          <div className="auth-intro">
            Welcome back. Access your apartment operations dashboard.
          </div>

          <form onSubmit={handleLogin} className="auth-form" aria-live="polite">
            <label>
              Email
              <input name="email" type="email" defaultValue={initialLogin.email} autoComplete="email" required />
            </label>
            <label>
              Password
              <input name="password" type="password" defaultValue={initialLogin.password} autoComplete="current-password" required />
            </label>
            {error ? <p className="error-text" role="alert">{error}</p> : null}
            <button type="submit" className="primary-btn">Sign in to dashboard</button>
</form>

        </div>
      </div>
    );
  }

  const stats = dashboard?.stats || {};
  const units = dashboard?.units || [];
  const tenants = dashboard?.tenants || [];
  const leases = dashboard?.leases || [];
  const payments = dashboard?.payments || [];
  const maintenance = dashboard?.maintenance || [];
  const role = String(user?.role || '').toLowerCase();

  const navItems = [
    ['overview', 'Overview'],
    ['units', 'Units'],
    ['tenants', 'Tenants'],
    ['leases', 'Leases'],
    ['deposits', 'Security Deposits'],
    ['payments', 'Payments'],
    ['maintenance', 'Maintenance'],
    ['reports', 'Reports'],
  ].filter(([key]) => {
    if (role === 'admin') return true;
    if (role === 'manager') return ['overview', 'units', 'tenants', 'leases', 'deposits', 'payments', 'reports'].includes(key);
    if (role === 'accountant') return ['overview', 'payments', 'leases', 'deposits', 'reports'].includes(key);
    if (role === 'maintenance') return ['overview', 'units', 'maintenance'].includes(key);
    return true;
  });

  const beginEditUnit = (unit) => {
    setEditingUnitId(unit.id);
    setUnitForm({
      unitNumber: String(unit.unitNumber),
      floor: String(unit.floor),
      bedrooms: String(unit.bedrooms),
      bathrooms: String(unit.bathrooms || 2),
      rent: String(unit.rent),
      status: unit.status,
      occupancy: unit.occupancy,
    });
    setActiveTab('units');
  };

  const beginEditTenant = (tenant) => {
    setEditingTenantId(tenant.id);
    setTenantForm({
      name: tenant.name,
      email: tenant.email || '',
      phone: tenant.phone || '',
      unitId: tenant.unitId || units.find((unit) => Number(unit.unitNumber) === Number(tenant.unitNumber))?.id || '',
      unitNumber: String(tenant.unitNumber || ''),
      moveInDate: tenant.moveInDate || '',
      status: tenant.status,
    });
    setActiveTab('tenants');
  };

  const beginEditPayment = (payment) => {
    const selectedTenant = tenants.find((tenant) => String(tenant.id) === String(payment.tenantId));
    const selectedUnit = units.find((unit) => (
      (payment.unitId && String(unit.id) === String(payment.unitId))
      || Number(unit.unitNumber) === Number(payment.unitNumber)
    ));
    setEditingPaymentId(payment.id);
    setPaymentForm({
      tenantId: payment.tenantId || '',
      unitId: payment.unitId || selectedTenant?.unitId || selectedUnit?.id || '',
      unitNumber: String(payment.unitNumber || ''),
      amount: String(payment.amount || ''),
      paidAmount: String(payment.paidAmount ?? ''),
      dueDate: payment.dueDate || todayIso(),
      paidDate: payment.paidDate || '',
      status: payment.status,
      method: payment.method || 'ACH',
      notes: payment.notes || '',
    });
    setActiveTab('payments');
  };

  const beginEditMaintenance = (item) => {
    setEditingMaintenanceId(item.id);
    setMaintenanceForm({
      unitNumber: String(item.unitNumber || ''),
      title: item.title || '',
      description: item.description || '',
      priority: item.priority || 'Medium',
      status: item.status || 'Pending',
      assignedTechnician: item.assignedTechnician || '',
      requestDate: item.requestDate || item.createdAt || todayIso(),
      dueDate: item.dueDate || '',
      completionDate: item.completionDate || '',
      reminderAt: item.reminderAt || '',
      notes: item.notes || '',
    });
    setActiveTab('maintenance');
  };

  const setUnitValue = (field, value) => setUnitForm((prev) => ({ ...prev, [field]: value }));
  const setTenantValue = (field, value) => setTenantForm((prev) => ({ ...prev, [field]: value }));
  const setPaymentValue = (field, value) => setPaymentForm((prev) => ({ ...prev, [field]: value }));
  const setMaintenanceValue = (field, value) => setMaintenanceForm((prev) => ({ ...prev, [field]: value }));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark"><img src={`${import.meta.env.BASE_URL}riiroow-logo.png`} alt="Riiroow Apartments logo" /></div>
          <div>
            <p className="eyebrow">Apartment</p>
            <h2>Riiroow</h2>
          </div>
        </div>

        <nav className="nav">
          {navItems.map(([key, label]) => (
            <button
              key={key}
              className={activeTab === key ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setActiveTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="user-card">
          <p>Signed in as</p>
          <strong>{user.name}</strong>
          <span>{user.role}</span>
          <button
            className="ghost-btn"
            onClick={() => {
              setUser(null);
              setToken('');
              setDashboard(null);
              setError('');
              setInfoMessage('');
            }}
          >
            Log out
          </button>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Dashboard</p>
            <h1>Apartment Management System</h1>
          </div>
          <div className="header-actions">
            <span className="status-pill">{stats.totalUnits ?? 0} Units · {stats.occupiedUnits ?? 0} Occupied</span>
          </div>
        </header>

        {error ? <div className="notice error" role="alert">{error}</div> : null}
        {infoMessage ? <div className="notice success" role="status">{infoMessage}</div> : null}

        {loading ? <DashboardLoading /> : (
          <>
            {activeTab === 'overview' ? (
              <>
                <section className="stats-grid">
                  <StatCard label="Occupancy" value={`${stats.occupancyRate ?? 0}%`} detail={`${stats.occupiedUnits ?? 0} of ${stats.totalUnits ?? 0} units occupied`} tone="blue" />
                  <StatCard label="Monthly Rent" value={formatCurrency(stats.totalMonthlyRent)} detail="Gross scheduled rent" tone="green" />
                  <StatCard label="Outstanding" value={formatCurrency(stats.overduePayments)} detail="Due or overdue balances" tone="amber" />
                  <StatCard label="Open Maintenance" value={String(stats.openMaintenance ?? 0)} detail="Active service requests" tone="red" />

                </section>

                <section className="stats-grid">
                  <StatCard
                    label="Security Deposits Agreed"
                    value={depositOverview.loaded ? formatCurrency(depositOverview.agreedDeposit) : 'Loading...'}
                    detail="Total required under recorded leases"
                    tone="blue"
                  />
                  <StatCard
                    label="Security Deposits Received"
                    value={depositOverview.loaded ? formatCurrency(depositOverview.depositReceived) : 'Loading...'}
                    detail="Recorded deposit payments only"
                    tone="green"
                  />
                  <StatCard
                    label="Outstanding Deposits"
                    value={depositOverview.loaded ? formatCurrency(depositOverview.outstandingDeposit) : 'Loading...'}
                    detail="Agreed deposits not yet received"
                    tone="amber"
                  />
                  <StatCard
                    label="Available Deposits"
                    value={depositOverview.loaded ? formatCurrency(depositOverview.availableDeposit) : 'Loading...'}
                    detail="Received deposits less deductions and refunds"
                    tone="red"
                  />
                </section>

                <section className="panel-grid two-col">
                  <div className="panel">
                    <div className="panel-header">
                      <h3>Property snapshot</h3>
                    </div>
                    <div className="mini-list">
                      <div><span>Units</span><strong>{stats.totalUnits ?? 0}</strong></div>
                      <div><span>Vacant</span><strong>{stats.vacantUnits ?? 0}</strong></div>
                      <div><span>Paid this month</span><strong>{formatCurrency(stats.paidPayments)}</strong></div>
                      <div><span>Outstanding rent</span><strong>{formatCurrency(stats.overduePayments)}</strong></div>
                    </div>
                  </div>

                  <div className="panel">
                    <div className="panel-header">
                      <h3>Recent payment status</h3>
                    </div>
                    <ul className="list-slim">
                      {payments.length ? payments.slice(0, 4).map((payment) => (
                        <li key={payment.id}>
                          <span>Unit {payment.unitNumber}</span>
                          <span className={`tag ${getStatusClass(payment.status)}`}>{payment.status}</span>
                        </li>
                      )) : (
                        <li>
                          <span>No payment activity yet</span>
                        </li>
                      )}
                    </ul>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-header">
                    <h3>Unit overview</h3>
                  </div>
                  <div className="table-wrap">
                    {units.length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>Unit</th>
                            <th>Floor</th>
                            <th>Bedrooms</th>
                            <th>Rent</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {units.map((unit) => (
                            <tr key={unit.id}>
                              <td>{unit.unitNumber}</td>
                              <td>{unit.floor}</td>
                              <td>{unit.bedrooms}</td>
                              <td>{formatCurrency(unit.rent)}</td>
                              <td><span className={`tag ${getStatusClass(unit.status)}`}>{unit.status}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <EmptyState title="No units found" message="Add a unit to start tracking occupancy, rent, and maintenance." />
                    )}
                  </div>
                </section>
              </>
            ) : null}

            {activeTab === 'units' ? (
              <div className="stacked-sections">
                <section className="panel">
                  <div className="panel-header">
                    <h3>{editingUnitId ? 'Edit unit' : 'Add unit'}</h3>
                  </div>
                  <form className="crud-form" onSubmit={handleUnitSubmit}>
                    <div className="form-grid">
                      <label>
                        Unit number
                        <input value={unitForm.unitNumber} onChange={(e) => setUnitValue('unitNumber', e.target.value)} required />
                      </label>
                      <label>
                        Floor
                        <input type="number" min="1" max="5" value={unitForm.floor} onChange={(e) => setUnitValue('floor', e.target.value)} required />
                      </label>
                      <label>
                        Bedrooms
                        <input type="number" min="1" value={unitForm.bedrooms} onChange={(e) => setUnitValue('bedrooms', e.target.value)} required />
                      </label>
                      <label>
                        Bathrooms
                        <input type="number" min="1" value={unitForm.bathrooms} onChange={(e) => setUnitValue('bathrooms', e.target.value)} required />
                      </label>
                      <label>
                        Monthly rent
                        <input type="number" min="0" value={unitForm.rent} onChange={(e) => setUnitValue('rent', e.target.value)} required />
                      </label>
                      <label>
                        Status
                        <select value={unitForm.status} onChange={(e) => setUnitValue('status', e.target.value)}>
                          <option value="occupied">Occupied</option>
                          <option value="vacant">Vacant</option>
                          <option value="maintenance">Maintenance</option>
                        </select>
                      </label>
                    </div>
                    <div className="form-actions">
                      <button type="submit" className="primary-btn">{editingUnitId ? 'Save unit' : 'Add unit'}</button>
                      {editingUnitId ? (
                        <button type="button" className="secondary-btn" onClick={() => { setEditingUnitId(null); setUnitForm(emptyUnitForm); }}>
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </form>
                </section>

                <section className="panel">
                  <div className="panel-header">
                    <h3>Unit list</h3>
                    <button type="button" className="small-btn" onClick={printUnitQRCodes}>
                      Export QR Codes
                    </button>
                  </div>
                  <div className="table-wrap">
                    {units.length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>Unit</th>
                            <th>Floor</th>
                            <th>Bedrooms</th>
                            <th>Rent</th>
                            <th>Status</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {units.map((unit) => (
                            <tr key={unit.id}>
                              <td>{unit.unitNumber}</td>
                              <td>{unit.floor}</td>
                              <td>{unit.bedrooms}</td>
                              <td>{formatCurrency(unit.rent)}</td>
                              <td><span className={`tag ${getStatusClass(unit.status)}`}>{unit.status}</span></td>
                              <td className="action-cell">
                                <button className="small-btn" onClick={() => beginEditUnit(unit)}>Edit</button>
                                <button className="small-btn danger" onClick={() => deleteUnit(unit.id)}>Delete</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <EmptyState title="No units available" message="Create a new apartment record to populate this list." />
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {activeTab === 'tenants' ? (
              <div className="stacked-sections">
                <section className="panel">
                  <div className="panel-header">
                    <h3>{editingTenantId ? 'Edit tenant' : 'Add tenant'}</h3>
                  </div>
                  <form className="crud-form" onSubmit={handleTenantSubmit}>
                    <div className="form-grid">
                      <label>
                        Full name
                        <input value={tenantForm.name} onChange={(e) => setTenantValue('name', e.target.value)} required />
                      </label>
                      <label>
                        Apartment unit
                        <select
                          value={tenantForm.unitId}
                          onChange={(e) => {
                            const selectedUnit = units.find((unit) => String(unit.id) === e.target.value);
                            setTenantForm((prev) => ({
                              ...prev,
                              unitId: e.target.value,
                              unitNumber: selectedUnit ? String(selectedUnit.unitNumber) : '',
                            }));
                          }}
                          required
                        >
                          <option value="">Select a unit</option>
                          {units.map((unit) => {
                            const occupiedByAnotherTenant = tenants.some((tenant) => (
                              tenant.id !== editingTenantId
                              && tenant.status === 'Active'
                              && Number(tenant.unitNumber) === Number(unit.unitNumber)
                            ));
                            return (
                              <option key={unit.id} value={unit.id} disabled={occupiedByAnotherTenant}>
                                Unit {unit.unitNumber}{occupiedByAnotherTenant ? ' (Occupied)' : ''}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                      <label>
                        Email
                        <input type="email" value={tenantForm.email} onChange={(e) => setTenantValue('email', e.target.value)} />
                      </label>
                      <label>
                        Phone
                        <input value={tenantForm.phone} onChange={(e) => setTenantValue('phone', e.target.value)} />
                      </label>
                      <label>
                        Move-in date
                        <input type="date" value={tenantForm.moveInDate} onChange={(e) => setTenantValue('moveInDate', e.target.value)} />
                      </label>
                      <label>
                        Status
                        <select value={tenantForm.status} onChange={(e) => setTenantValue('status', e.target.value)}>
                          <option value="Active">Active</option>
                          <option value="Inactive">Inactive</option>
                          <option value="Pending">Pending</option>
                        </select>
                      </label>
                    </div>
                    <div className="form-actions">
                      <button type="submit" className="primary-btn">{editingTenantId ? 'Save tenant' : 'Add tenant'}</button>
                      {editingTenantId ? (
                        <button type="button" className="secondary-btn" onClick={() => { setEditingTenantId(null); setTenantForm(emptyTenantForm); }}>
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </form>
                </section>

                <section className="panel">
                  <div className="panel-header">
                    <h3>Tenant roster</h3>
                  </div>
                  <div className="table-wrap">
                    {tenants.length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Unit</th>
                            <th>Email</th>
                            <th>Phone</th>
                            <th>Status</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tenants.map((tenant) => (
                            <tr key={tenant.id}>
                              <td>{tenant.name}</td>
                              <td>{tenant.unitNumber}</td>
                              <td>{tenant.email}</td>
                              <td>{tenant.phone}</td>
                              <td><span className={`tag ${getStatusClass(tenant.status)}`}>{tenant.status}</span></td>
                              <td className="action-cell">
                                <button className="small-btn" onClick={() => viewTenantPayments(tenant)}>Payments</button>
                                <button className="small-btn" onClick={() => beginEditTenant(tenant)}>Edit</button>
                                <button className="small-btn danger" onClick={() => deleteTenant(tenant.id)}>Delete</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <EmptyState title="No tenants yet" message="Add a resident to begin managing occupancy records." />
                    )}
                  </div>
                </section>

                {selectedTenantPayments ? (
                  <section className="panel">
                    <div className="panel-header">
                      <h3>{selectedTenantPayments.tenant.name} payment history</h3>
                      <button className="secondary-btn" onClick={() => setSelectedTenantPayments(null)}>Close</button>
                    </div>
                    <div className="stats-grid">
                      <StatCard label="Total due" value={formatCurrency(selectedTenantPayments.totals.totalRentDue)} detail="Total rent due" tone="blue" />
                      <StatCard label="Total paid" value={formatCurrency(selectedTenantPayments.totals.totalPaid)} detail="Amount paid" tone="green" />
                      <StatCard label="Remaining" value={formatCurrency(selectedTenantPayments.totals.totalRemaining)} detail="Unpaid balance" tone="amber" />
                      <StatCard label="Outstanding" value={formatCurrency(selectedTenantPayments.totals.totalOutstanding)} detail="Outstanding payments" tone="amber" />
                      <StatCard label="Overdue" value={formatCurrency(selectedTenantPayments.totals.totalOverdue)} detail="Overdue payments" tone="red" />
                    </div>
                    <div className="table-wrap">
                      {selectedTenantPayments.payments.length ? (
                        <table>
                          <thead>
                            <tr>
                              <th>Amount Due</th>
                              <th>Amount Paid</th>
                              <th>Remaining</th>
                              <th>Due date</th>
                              <th>Paid date</th><th>Recorded</th>
                              <th>Status</th>
                              <th>Method</th>
                              <th>Unit</th>
                              <th>Notes</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedTenantPayments.payments.map((payment) => (
                              <tr key={payment.id}>
                                <td>{formatCurrency(payment.amount)}</td>
                                <td>{formatCurrency(payment.paidAmount)}</td>
                                <td>{formatCurrency(payment.remainingAmount)}</td>
                                <td>{payment.dueDate || 'Ã¯Â¿Â½'}</td>
                                <td>{payment.paidDate || 'Ã¯Â¿Â½'}</td><td>{formatDateTime(payment.createdAt)}</td>
                                <td><span className={`tag ${getStatusClass(payment.status)}`}>{payment.status}</span></td>
                                <td>{payment.method || 'Ã¯Â¿Â½'}</td>
                                <td>{payment.unitNumber || 'Ã¯Â¿Â½'}</td>
                                <td>{payment.notes || 'Ã¯Â¿Â½'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <EmptyState title="No payments found" message="This tenant has no payment records yet." />
                      )}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}

            {activeTab === 'leases' ? (
              <div className="stacked-sections">
                <section className="panel">
                  <div className="panel-header">
                    <h3>{editingLeaseId ? 'Edit lease' : 'Add lease'}</h3>
                  </div>

                  <form className="crud-form" onSubmit={handleLeaseSubmit}>
                    <div className="form-grid">
                      <label>
                        Tenant
                        <select
                          value={leaseForm.tenantId}
                          onChange={(e) => {
                            const selectedTenant = tenants.find(
                              (tenant) => String(tenant.id) === e.target.value
                            );

                            const selectedUnit = units.find((unit) =>
                              (selectedTenant?.unitId && String(unit.id) === String(selectedTenant.unitId))
                              || Number(unit.unitNumber) === Number(selectedTenant?.unitNumber)
                            );

                            setLeaseForm((prev) => ({
                              ...prev,
                              tenantId: e.target.value,
                              unitId: selectedUnit?.id || '',
                              unitNumber: selectedUnit ? String(selectedUnit.unitNumber) : '',
                              monthlyRent: selectedUnit?.rent ?? prev.monthlyRent,
                            }));
                          }}
                          required
                        >
                          <option value="">Select a tenant</option>
                          {tenants.map((tenant) => (
                            <option key={tenant.id} value={tenant.id}>
                              {tenant.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label>
                        Unit
                        <select
                          value={leaseForm.unitId}
                          onChange={(e) => {
                            const selectedUnit = units.find(
                              (unit) => String(unit.id) === e.target.value
                            );

                            setLeaseForm((prev) => ({
                              ...prev,
                              unitId: e.target.value,
                              unitNumber: selectedUnit ? String(selectedUnit.unitNumber) : '',
                              monthlyRent: selectedUnit?.rent ?? prev.monthlyRent,
                            }));
                          }}
                          required
                        >
                          <option value="">Select a unit</option>
                          {units.map((unit) => (
                            <option key={unit.id} value={unit.id}>
                              {unit.unitNumber}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label>
                        Start date
                        <input
                          type="date"
                          value={leaseForm.startDate}
                          onChange={(e) => setLeaseForm((prev) => ({
                            ...prev,
                            startDate: e.target.value,
                          }))}
                          required
                        />
                      </label>

                      <label>
                        End date
                        <input
                          type="date"
                          value={leaseForm.endDate}
                          onChange={(e) => setLeaseForm((prev) => ({
                            ...prev,
                            endDate: e.target.value,
                          }))}
                        />
                      </label>

                      <label>
                        Monthly rent
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={leaseForm.monthlyRent}
                          onChange={(e) => setLeaseForm((prev) => ({
                            ...prev,
                            monthlyRent: e.target.value,
                          }))}
                          required
                        />
                      </label>

                      <label>
                        Security deposit
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={leaseForm.securityDeposit}
                          onChange={(e) => setLeaseForm((prev) => ({
                            ...prev,
                            securityDeposit: e.target.value,
                          }))}
                        />
                      </label>

                      <label>
                        Status
                        <select
                          value={leaseForm.status}
                          onChange={(e) => setLeaseForm((prev) => ({
                            ...prev,
                            status: e.target.value,
                          }))}
                        >
                          <option value="Active">Active</option>
                          <option value="Pending">Pending</option>
                          <option value="Expired">Expired</option>
                          <option value="Terminated">Terminated</option>
                        </select>
                      </label>

                      <label>
                        Notes
                        <textarea
                          value={leaseForm.notes}
                          onChange={(e) => setLeaseForm((prev) => ({
                            ...prev,
                            notes: e.target.value,
                          }))}
                          rows="3"
                          placeholder="Optional lease notes"
                        />
                      </label>
                    </div>

                    <div className="form-actions">
                      <button className="primary-btn" type="submit">
                        {editingLeaseId ? 'Update lease' : 'Create lease'}
                      </button>


                      {editingLeaseId ? (
                        <button
                          className="secondary-btn"
                          type="button"
                          onClick={cancelEditLease}
                        >
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </form>
                </section>

                <section className="panel">
                  <div className="panel-header">
                    <h3>Lease overview</h3>
                  </div>

                  <div className="stats-grid">
                    {(() => {
                      const leases = dashboard?.leases || [];
                      const activeLeases = leases.filter(
                        (lease) => String(lease.status).toLowerCase() === 'active'
                      );
                      const expiredLeases = leases.filter(
                        (lease) => String(lease.status).toLowerCase() === 'expired'
                      );
                      const terminatedLeases = leases.filter(
                        (lease) => String(lease.status).toLowerCase() === 'terminated'
                      );
                      const expiringSoon = activeLeases.filter((lease) => {
                        const label = getLeaseExpirationLabel(lease.endDate, lease.status);
                        const match = label.match(/^(\d+) days?$/);
                        return match && Number(match[1]) <= 30;
                      });

                      return (
                        <>
                          <div className="stat-card">
                            <span>Total Leases</span>
                            <strong>{leases.length}</strong>
                          </div>

                          <div className="stat-card">
                            <span>Active</span>
                            <strong>{activeLeases.length}</strong>
                          </div>

                          <div className="stat-card">
                            <span>Expiring Soon</span>
                            <strong>{expiringSoon.length}</strong>
                          </div>

                          <div className="stat-card">
                            <span>Expired</span>
                            <strong>{expiredLeases.length}</strong>
                          </div>

                          <div className="stat-card">
                            <span>Terminated</span>
                            <strong>{terminatedLeases.length}</strong>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-header">
                    <h3>Lease records</h3>
                  </div>

                  <div className="table-wrap">
                    {(dashboard?.leases || []).length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>Lease</th>
                            <th>Tenant</th>
                            <th>Unit</th>
                            <th>Start</th>
                            <th>End</th>
                            <th>Expires In</th>
                            <th>Rent</th>
                            <th>Deposit</th>
                            <th>Status</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(dashboard?.leases || []).map((lease) => {
                            const tenant = tenants.find(
                              (item) => String(item.id) === String(lease.tenantId)
                            );

                            return (
                              <tr key={lease.id}>
                                <td>Lease #{String(lease.id).split('-').pop() || '—'}</td>
                                <td>{tenant?.name || lease.tenantId || '—'}</td>
                                <td>{lease.unitNumber}</td>
                                <td>{lease.startDate || '—'}</td>
                                <td>{lease.endDate || '—'}</td>
                                <td>
                                  <span className={`tag ${getStatusClass(getLeaseExpirationLabel(lease.endDate, lease.status))}`}>
                                    {getLeaseExpirationLabel(lease.endDate, lease.status)}
                                  </span>
                                </td>
                                <td>{formatCurrency(lease.monthlyRent)}</td>
                                <td>{formatCurrency(lease.securityDeposit)}</td>
                                <td>

  {(() => {
    const displayStatus =
      getLeaseExpirationLabel(lease.endDate, lease.status);

    return (
      <span className={`tag ${getStatusClass(displayStatus)}`}>
        {displayStatus}
      </span>
    );
  })()}
</td>
                                <td>
                                  <div className="form-actions">
                                    <button
                                      className="small-btn"
                                      type="button"
                                      onClick={() => beginEditLease(lease)}
                                    >
                                      Edit
                                    </button>

                                                                        {['admin', 'manager'].includes(role) &&
                                    String(lease.status).toLowerCase() === 'active' ? (
                                      <button
                                        className="small-btn"
                                        type="button"
                                        onClick={() => handleGenerateTenantPin(lease)}
                                      >
                                        Generate / Reset Tenant PIN
                                      </button>
                                    ) : null}
                                    <button
                                      className="small-btn"
                                      type="button"
                                      onClick={() => printLease(lease)}
                                    >
                                      Print Lease
                                    </button>

                                    {String(lease.status).toLowerCase() !== 'terminated' ? (
                                      <button
                                        className="small-btn"
                                        type="button"
                                        onClick={() => handleRenewLease(lease)}
                                      >
                                        Renew
                                      </button>
                                    ) : null}


                                    {String(lease.status).toLowerCase() !== 'terminated' ? (
                                      <button
                                        className="small-btn danger"
                                        type="button"
                                        onClick={() => handleTerminateLease(lease)}
                                      >
                                        Terminate
                                      </button>
                                    ) : null}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <EmptyState
                        title="No lease records"
                        message="Lease details will appear here once a resident is assigned."
                      />
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {activeTab === 'deposits' ? (
        <div className="stacked-sections">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Security Deposits</h2>
                <p>Manage agreed deposits separately from monthly rent.</p>
              </div>
            </div>

            <div className="crud-form">
              <div className="form-grid">
                <label>
                  Lease
                  <select
                    value={selectedDepositLeaseId}
                    onChange={(event) => {
                      setSelectedDepositLeaseId(event.target.value);
                      setDepositSummary(null);
                    }}
                  >
                    <option value="">Select a lease</option>
                    {(dashboard?.leases || []).map((lease) => (
                      <option key={lease.id} value={lease.id}>
                        {`Unit ${lease.unit_number ?? lease.unitNumber ?? lease.unit_id ?? 'â€”'} â€” ${lease.tenant_name ?? lease.tenantName ?? lease.tenant_id ?? 'Tenant'} `}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="form-actions">
                <button
                  type="button"
                  className="small-btn"
                  disabled={!selectedDepositLeaseId || depositLoading}
                  onClick={() => loadSecurityDeposit(selectedDepositLeaseId)}
                >
                  {depositLoading ? 'Loading...' : 'Load Deposit Records'}
                </button>
              </div>
            </div>

            {depositSummary && (
              <>
                <div className="form-grid">
                  <div>
                    <strong>Agreed deposit</strong>
                    <p>{formatCurrency(depositSummary.agreedDeposit)}</p>
                  </div>
                  <div>
                    <strong>Deposit received</strong>
                    <p>{formatCurrency(depositSummary.depositReceived)}</p>
                  </div>
                  <div>
                    <strong>Outstanding deposit</strong>
                    <p>{formatCurrency(depositSummary.outstandingDeposit)}</p>
                  </div>
                  <div>
                    <strong>Total deductions</strong>
                    <p>{formatCurrency(depositSummary.totalDeductions)}</p>
                  </div>
                  <div>
                    <strong>Total refunded</strong>
                    <p>{formatCurrency(depositSummary.totalRefunded)}</p>
                  </div>
                  <div>
                    <strong>Available deposit</strong>
                    <p>{formatCurrency(depositSummary.availableDeposit)}</p>
                  </div>
                </div>

                {(role === 'admin' || role === 'manager') && (
                  <form className="crud-form" onSubmit={handleDepositSubmit}>
                    <h3>Record a Deposit Transaction</h3>

                    <div className="form-grid">
                      <label>
                        Transaction type
                        <select
                          value={depositForm.type}
                          onChange={(event) =>
                            setDepositForm((previous) => ({
                              ...previous,
                              type: event.target.value,
                            }))
                          }
                        >
                          <option value="payment">Deposit payment received</option>
                          <option value="deduction">Move-out deduction</option>
                          <option value="refund">Deposit refund</option>
                        </select>
                      </label>

                      <label>
                        Amount
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          required
                          value={depositForm.amount}
                          onChange={(event) =>
                            setDepositForm((previous) => ({
                              ...previous,
                              amount: event.target.value,
                            }))
                          }
                          placeholder="0.00"
                        />
                      </label>

                      <label>
                        Transaction date
                        <input
                          type="date"
                          required
                          value={depositForm.transactionDate}
                          onChange={(event) =>
                            setDepositForm((previous) => ({
                              ...previous,
                              transactionDate: event.target.value,
                            }))
                          }
                        />
                      </label>

                      <label>
                        Notes / deduction reason
                        <input
                          type="text"
                          maxLength="1000"
                          value={depositForm.notes}
                          onChange={(event) =>
                            setDepositForm((previous) => ({
                              ...previous,
                              notes: event.target.value,
                            }))
                          }
                          placeholder="Payment reference or reason for deduction/refund"
                        />
                      </label>
                    </div>

                    <div className="form-actions">
                      <button
                        type="submit"
                        className="small-btn"
                        disabled={depositLoading}
                      >
                        Record Transaction
                      </button>
                    </div>
                  </form>
                )}

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Type</th>
                        <th>Amount</th>
                        <th>Notes</th>
                        <th>Recorded by</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(depositSummary.transactions || []).length === 0 ? (
                        <tr>
                          <td colSpan="5">No security-deposit transactions recorded.</td>
                        </tr>
                      ) : (
                        depositSummary.transactions.map((transaction) => (
                          <tr key={transaction.id}>
                            <td>
                              {formatDateTime(
                                transaction.transaction_date ??
                                transaction.transactionDate ??
                                transaction.created_at
                              )}
                            </td>
                            <td>
                              {String(
                                transaction.transaction_type ??
                                transaction.transactionType ??
                                transaction.type ??
                                ''
                              ).replace(/_/g, ' ')}
                            </td>
                            <td>{formatCurrency(transaction.amount)}</td>
                            <td>{transaction.notes || 'â€”'}</td>
                            <td>{transaction.recorded_by ?? transaction.recordedBy ?? 'â€”'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === 'payments' ? (
              <div className="stacked-sections">
                <section className="panel">
                  <div className="panel-header">
                    <h3>{editingPaymentId ? 'Edit payment' : 'Add payment'}</h3>
                  </div>
                  <form className="crud-form" onSubmit={handlePaymentSubmit}>
                    <div className="form-grid">
                      <label>
                        Tenant
                        <select
                          value={paymentForm.tenantId}
                          onChange={(e) => {
                            const selectedTenant = tenants.find((tenant) => String(tenant.id) === e.target.value);
                            const selectedUnit = units.find((unit) => (
                              (selectedTenant?.unitId && String(unit.id) === String(selectedTenant.unitId))
                              || Number(unit.unitNumber) === Number(selectedTenant?.unitNumber)
                            ));
                            setPaymentForm((prev) => ({
                              ...prev,
                              tenantId: e.target.value,
                              unitId: selectedUnit?.id || '',
                              unitNumber: selectedUnit ? String(selectedUnit.unitNumber) : '',
                            }));
                          }}
                          required
                        >
                          <option value="">Select a tenant</option>
                          {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
                        </select>
                      </label>
                      <label>
                        Assigned unit
                        <input value={paymentForm.unitNumber ? `Unit ${paymentForm.unitNumber}` : 'Select a tenant'} readOnly required />
                      </label>
                      <label>
                        Amount Due
                        <input type="number" min="0" step="0.01" value={paymentForm.amount} onChange={(e) => setPaymentValue('amount', e.target.value)} required />
                      </label>
                      <label>
                        Amount Paid
                        <input type="number" min="0" step="0.01" value={paymentForm.paidAmount} onChange={(e) => setPaymentValue('paidAmount', e.target.value)} />
                      </label>
                      <label>
                        Remaining Balance
                        <input type="text" value={formatCurrency(Math.max(0, Number(paymentForm.amount || 0) - Number(paymentForm.paidAmount || 0)))} readOnly />
                      </label>
                      <label>
                        Due date
                        <input type="date" value={paymentForm.dueDate} onChange={(e) => setPaymentValue('dueDate', e.target.value)} required />
                      </label>
                      <label>
                        Paid date
                        <input type="date" value={paymentForm.paidDate} onChange={(e) => setPaymentValue('paidDate', e.target.value)} />
                      </label>
                      <label>
                        Status
                        <select value={paymentForm.status} onChange={(e) => setPaymentValue('status', e.target.value)}>
                          <option value="Outstanding">Outstanding</option>
                          <option value="Paid">Paid</option>
                          <option value="Overdue">Overdue</option>
                        </select>
                      </label>
                      <label>
                        Payment method
                        <select value={paymentForm.method} onChange={(e) => setPaymentValue('method', e.target.value)}>
                          <option value="ACH">ACH</option>
                          <option value="Card">Card</option>
                          <option value="Check">Check</option>
                          <option value="Bank transfer">Bank transfer</option>
                        </select>
                      </label>
                    </div>
                    <div className="form-actions">
                      <button type="submit" className="primary-btn">{editingPaymentId ? 'Save payment' : 'Add payment'}</button>
                      {editingPaymentId ? (
                        <button type="button" className="secondary-btn" onClick={() => { setEditingPaymentId(null); setPaymentForm(emptyPaymentForm); }}>
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </form>
                </section>

                <section className="panel">
                  <div className="panel-header">
                    <h3>Payment history</h3>
                    <button className="secondary-btn" type="button" onClick={exportPaymentsToExcel} disabled={!dashboard}>
                      Export to Excel
                    </button>
                  </div>
                  <div className="table-wrap">
                    {payments.length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>Unit</th>
                            <th>Amount Due</th>
                            <th>Amount Paid</th>
                            <th>Remaining</th>
                            <th>Due date</th>
                            <th>Paid date</th>
                            <th>Status</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {payments.map((payment) => (
                            <tr key={payment.id}>
                              <td>{payment.unitNumber}</td>
                              <td>{formatCurrency(payment.amount)}</td>
                              <td>{formatCurrency(payment.paidAmount)}</td>
                              <td>{formatCurrency(payment.remainingAmount)}</td>
                              <td>{payment.dueDate}</td>
                              <td>{payment.paidDate || '—'}</td>
                              <td><span className={`tag ${getStatusClass(payment.status)}`}>{payment.status}</span></td>
                              <td className="action-cell">
                                <button className="small-btn" onClick={() => printPaymentReceipt(payment)}>Print Receipt</button>
                                <button className="small-btn" onClick={() => beginEditPayment(payment)}>Edit</button>
                                <button className="small-btn danger" onClick={() => deletePayment(payment.id)}>Delete</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <EmptyState title="No payment records" message="Record upcoming rent or payment activity here." />
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {activeTab === 'maintenance' ? (
              <div className="stacked-sections">
                <section className="panel">
                  <div className="panel-header">
                    <h3>{editingMaintenanceId ? 'Edit maintenance request' : 'Add maintenance request'}</h3>
                  </div>
                  <form className="crud-form" onSubmit={handleMaintenanceSubmit}>
                    <div className="form-grid">
                      <label>
                        Unit number
                        <input type="number" min="101" value={maintenanceForm.unitNumber} onChange={(e) => setMaintenanceValue('unitNumber', e.target.value)} required />
                      </label>
                      <label>
                        Priority
                        <select value={maintenanceForm.priority} onChange={(e) => setMaintenanceValue('priority', e.target.value)}>
                          <option value="Low">Low</option>
                          <option value="Medium">Medium</option>
                          <option value="High">High</option>
                          <option value="Emergency">Emergency</option>
                        </select>
                      </label>
                      <label className="full-span">
                        Title
                        <input value={maintenanceForm.title} onChange={(e) => setMaintenanceValue('title', e.target.value)} required />
                      </label>
                      <label className="full-span">
                        Description
                        <textarea rows="3" value={maintenanceForm.description} onChange={(e) => setMaintenanceValue('description', e.target.value)} />
                      </label>
                      <label>
                        Status
                        <select value={maintenanceForm.status} onChange={(e) => setMaintenanceValue('status', e.target.value)}>
                          <option value="Pending">Pending</option>
                          <option value="In Progress">In Progress</option>
                          <option value="Scheduled">Scheduled</option>
                          <option value="Completed">Completed</option>
                          <option value="Resolved">Resolved</option>
                        </select>
                      </label>
                      <label>
                        Assigned technician
                        <input value={maintenanceForm.assignedTechnician} onChange={(e) => setMaintenanceValue('assignedTechnician', e.target.value)} />
                      </label>
                      <label>
                        Request date
                        <input type="date" value={maintenanceForm.requestDate} onChange={(e) => setMaintenanceValue('requestDate', e.target.value)} />
                      </label>
                      <label>
                        Due date
                        <input type="date" value={maintenanceForm.dueDate} onChange={(e) => setMaintenanceValue('dueDate', e.target.value)} />
                      </label>
                      <label>
                        Completion date
                        <input type="date" value={maintenanceForm.completionDate} onChange={(e) => setMaintenanceValue('completionDate', e.target.value)} />
                      </label>
                      <label>
                        Reminder date
                        <input type="datetime-local" value={maintenanceForm.reminderAt} onChange={(e) => setMaintenanceValue('reminderAt', e.target.value)} />
                      </label>
                      <label className="full-span">
                        Notes
                        <textarea rows="2" value={maintenanceForm.notes} onChange={(e) => setMaintenanceValue('notes', e.target.value)} />
                      </label>
                    </div>
                    <div className="form-actions">
                      <button type="submit" className="primary-btn">{editingMaintenanceId ? 'Save request' : 'Add request'}</button>
                      {editingMaintenanceId ? (
                        <button type="button" className="secondary-btn" onClick={() => { setEditingMaintenanceId(null); setMaintenanceForm(emptyMaintenanceForm); }}>
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </form>
                </section>

                <section className="panel">
                  <div className="panel-header">
                    <h3>Maintenance overview</h3>
                  </div>

                  <div className="stats-grid">
                    {(() => {
                      const pendingMaintenance = maintenance.filter(
                        (item) => String(item.status).toLowerCase() === 'pending'
                      );
                      const inProgressMaintenance = maintenance.filter(
                        (item) => String(item.status).toLowerCase() === 'in progress'
                      );
                      const scheduledMaintenance = maintenance.filter(
                        (item) => String(item.status).toLowerCase() === 'scheduled'
                      );
                      const completedMaintenance = maintenance.filter((item) => {
                        const status = String(item.status).toLowerCase();
                        return status === 'completed' || status === 'resolved';
                      });
                      const urgentMaintenance = maintenance.filter((item) => {
                        const priority = String(item.priority).toLowerCase();
                        return priority === 'high' || priority === 'emergency';
                      });
                      const overdueMaintenance = maintenance.filter((item) => {
                        const status = String(item.status).toLowerCase();
                        return (
                          item.dueDate &&
                          String(item.dueDate).slice(0, 10) < todayIso() &&
                          status !== 'completed' &&
                          status !== 'resolved'
                        );
                      });

                      return (
                        <>
                          <div className="stat-card">
                            <span>Total Requests</span>
                            <strong>{maintenance.length}</strong>
                          </div>

                          <div className="stat-card">
                            <span>Pending</span>
                            <strong>{pendingMaintenance.length}</strong>
                          </div>

                          <div className="stat-card">
                            <span>In Progress</span>
                            <strong>{inProgressMaintenance.length}</strong>
                          </div>

                          <div className="stat-card">
                            <span>Scheduled</span>
                            <strong>{scheduledMaintenance.length}</strong>
                          </div>

                          <div className="stat-card">
                            <span>Completed</span>
                            <strong>{completedMaintenance.length}</strong>
                          </div>

                          <div className="stat-card">
                            <span>Urgent</span>
                            <strong>{urgentMaintenance.length}</strong>
                          </div>

                          <div className="stat-card">
                            <span>Overdue</span>
                            <strong>{overdueMaintenance.length}</strong>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-header">
                    <h3>Maintenance requests</h3>
                  </div>
                  <div className="table-wrap">
                    {maintenance.length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>Unit</th>
                            <th>Title</th>
                            <th>Priority</th>
                            <th>Status</th>
                            <th>Technician</th>
                            <th>Requested</th>
                            <th>Due</th>
                            <th>Completed</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {maintenance.map((item) => (
                            <tr key={item.id}>
                              <td>{item.unitNumber}</td>
                              <td>{item.title}</td>
                              <td>{item.priority}</td>
                              <td><span className={`tag ${getStatusClass(item.status)}`}>{item.status}</span></td>
                              <td>{item.assignedTechnician || '—'}</td>
                              <td>{item.requestDate || '—'}</td>
                              <td>{item.dueDate || '—'}</td>
                              <td>{item.completionDate || '—'}</td>
                              <td className="action-cell">
                                {String(item.status).toLowerCase() !== 'in progress' && String(item.status).toLowerCase() !== 'completed' && String(item.status).toLowerCase() !== 'resolved' && (
                                  <button className="small-btn" onClick={() => updateMaintenanceStatus(item, 'In Progress')}>Start</button>
                                )}
                                {String(item.status).toLowerCase() !== 'scheduled' && String(item.status).toLowerCase() !== 'completed' && String(item.status).toLowerCase() !== 'resolved' && (
                                  <button className="small-btn" onClick={() => updateMaintenanceStatus(item, 'Scheduled')}>Schedule</button>
                                )}
                                {String(item.status).toLowerCase() !== 'completed' && String(item.status).toLowerCase() !== 'resolved' && (
                                  <button className="small-btn" onClick={() => updateMaintenanceStatus(item, 'Completed')}>Complete</button>
                                )}
                                <button className="small-btn" onClick={() => viewMaintenanceEvidence(item)}>View Attachments</button>
                                <button className="small-btn" onClick={() => beginEditMaintenance(item)}>Edit</button>
                                <button className="small-btn danger" onClick={() => deleteMaintenance(item.id)}>Delete</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <EmptyState title="No maintenance requests" message="Track repairs and service work as they come in." />
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {activeTab === 'reports' ? (
              <div className="content-grid">
                <section className="panel">
                  <div className="panel-header">
                    <div>
                      <p className="eyebrow">Reports & Analytics</p>
                      <h2>Property performance</h2>
                    </div>
                    <button className="secondary-btn" type="button" onClick={exportReportsToExcel} disabled={!dashboard}>
                      Export to Excel
                    </button>
                  </div>

                  <div className="stats-grid">
                    <StatCard
                      label="Total Units"
                      value={String(stats.totalUnits ?? 0)}
                      detail={`${stats.occupiedUnits ?? 0} occupied · ${stats.vacantUnits ?? 0} vacant`}
                      tone="blue"
                    />
                    <StatCard
                      label="Occupancy Rate"
                      value={`${stats.occupancyRate ?? 0}%`}
                      detail="Current property occupancy"
                      tone="green"
                    />
                    <StatCard
                      label="Monthly Rent"
                      value={formatCurrency(stats.totalMonthlyRent)}
                      detail="Gross scheduled rent"
                      tone="green"
                    />
                    <StatCard
                      label="Paid"
                      value={formatCurrency(stats.paidPayments)}
                      detail="Recorded payments"
                      tone="blue"
                    />
                    <StatCard
                      label="Outstanding"
                      value={formatCurrency(stats.totalOutstanding)}
                      detail="Unpaid balances"
                      tone="amber"
                    />
                    <StatCard
                      label="Overdue"
                      value={formatCurrency(stats.totalOverdue)}
                      detail="Overdue balances"
                      tone="red"
                    />
                    <StatCard
                      label="Active Leases"
                      value={String(leases.filter((lease) => String(lease.status).toLowerCase() === 'active').length)}
                      detail={`${leases.length} total leases`}
                      tone="blue"
                    />
                    <StatCard
                      label="Open Maintenance"
                      value={String(stats.openMaintenance ?? 0)}
                      detail="Unresolved service requests"
                      tone="red"
                    />
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-header">
                    <div>
                      <p className="eyebrow">Portfolio summary</p>
                      <h2>Current operational snapshot</h2>
                    </div>
                  </div>

                  <div className="summary-list">
                    <div><span>Tenants</span><strong>{tenants.length}</strong></div>
                    <div><span>Leases</span><strong>{leases.length}</strong></div>
                    <div><span>Payments recorded</span><strong>{payments.length}</strong></div>
                    <div><span>Maintenance requests</span><strong>{maintenance.length}</strong></div>
                    <div><span>Occupied units</span><strong>{stats.occupiedUnits ?? 0}</strong></div>
                    <div><span>Vacant units</span><strong>{stats.vacantUnits ?? 0}</strong></div>
                  </div>
                </section>
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value, detail, tone }) {
  return (
    <div className={`stat-card ${tone}`}>
      <p>{label}</p>
      <h3>{value}</h3>
      <span>{detail}</span>


      
</div>
  );
}

function AppErrorBoundaryWrapped() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}

export default AppErrorBoundaryWrapped;
