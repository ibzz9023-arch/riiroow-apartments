import { useEffect, useState } from 'react';

const formatCurrency = (value) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

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
  const [editingPaymentId, setEditingPaymentId] = useState(null);
  const [editingMaintenanceId, setEditingMaintenanceId] = useState(null);
  const [selectedTenantPayments, setSelectedTenantPayments] = useState(null);
  const [unitForm, setUnitForm] = useState(emptyUnitForm);
  const [tenantForm, setTenantForm] = useState(emptyTenantForm);
  const [paymentForm, setPaymentForm] = useState(emptyPaymentForm);
  const [maintenanceForm, setMaintenanceForm] = useState(emptyMaintenanceForm);

  const requestJson = async (path, options = {}) => {
    const { method = 'GET', body, headers = {} } = options;
    const response = await fetch(path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Request failed.');
    }

    return data;
  };

  const fetchDashboard = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await requestJson('/api/dashboard');
      setDashboard(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
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
      const email = formData.get('email');
      const password = formData.get('password');

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

  if (!user) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="brand-header">
            <div className="brand-mark" aria-hidden="true">R</div>
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

          <div className="demo-account" aria-label="Demo account details">
            <span className="demo-label">Demo access</span>
            <strong>admin@riiroow.com</strong>
            <span>admin123</span>
          </div>
        </div>
      </div>
    );
  }

  const stats = dashboard?.stats || {};
  const units = dashboard?.units || [];
  const tenants = dashboard?.tenants || [];
  const payments = dashboard?.payments || [];
  const maintenance = dashboard?.maintenance || [];
  const role = String(user?.role || '').toLowerCase();

  const navItems = [
    ['overview', 'Overview'],
    ['units', 'Units'],
    ['tenants', 'Tenants'],
    ['leases', 'Leases'],
    ['payments', 'Payments'],
    ['maintenance', 'Maintenance'],
  ].filter(([key]) => {
    if (role === 'admin') return true;
    if (role === 'manager') return ['overview', 'units', 'tenants', 'leases', 'payments'].includes(key);
    if (role === 'accountant') return ['overview', 'payments', 'leases'].includes(key);
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
          <div className="brand-mark">R</div>
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
                              <th>Paid date</th>
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
                                <td>{payment.dueDate || '—'}</td>
                                <td>{payment.paidDate || '—'}</td>
                                <td><span className={`tag ${getStatusClass(payment.status)}`}>{payment.status}</span></td>
                                <td>{payment.method || '—'}</td>
                                <td>{payment.unitNumber || '—'}</td>
                                <td>{payment.notes || '—'}</td>
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
              <section className="panel">
                <div className="panel-header">
                  <h3>Lease management</h3>
                </div>
                <div className="table-wrap">
                  {(dashboard?.leases || []).length ? (
                    <table>
                      <thead>
                        <tr>
                          <th>Lease</th>
                          <th>Unit</th>
                          <th>Start</th>
                          <th>End</th>
                          <th>Rent</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(dashboard?.leases || []).map((lease) => (
                          <tr key={lease.id}>
                            <td>{lease.id}</td>
                            <td>{lease.unitNumber}</td>
                            <td>{lease.startDate}</td>
                            <td>{lease.endDate}</td>
                            <td>{formatCurrency(lease.monthlyRent)}</td>
                            <td><span className={`tag ${getStatusClass(lease.status)}`}>{lease.status}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <EmptyState title="No lease records" message="Lease details will appear here once a resident is assigned." />
                  )}
                </div>
              </section>
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
                            <th>Due</th>
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
                              <td>{item.dueDate || '—'}</td>
                              <td className="action-cell">
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

export default App;
