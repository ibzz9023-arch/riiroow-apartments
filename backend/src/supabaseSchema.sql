-- Riiroow Apartments Management System Schema

create extension if not exists "pgcrypto";

create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  city text,
  state text,
  zip_code text,
  floors integer not null default 5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password text not null,
  role text not null check (role in ('Admin', 'Manager', 'Accountant', 'Maintenance')),
  is_active boolean not null default true,
  permissions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists units (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete cascade,
  unit_number integer not null,
  floor integer not null,
  bedrooms integer not null default 1,
  bathrooms numeric not null default 1,
  rent numeric not null default 0,
  status text not null default 'vacant' check (status in ('vacant','occupied','maintenance')),
  occupancy text not null default 'Vacant' check (occupancy in ('Vacant','Occupied','Maintenance')),
  last_payment_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(property_id, unit_number)
);

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  unit_id uuid references units(id) on delete set null,
  unit_number integer,
  move_in_date date,
  status text not null default 'Active' check (status in ('Active','Inactive','Pending')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists leases (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete cascade,
  unit_id uuid references units(id) on delete cascade,
  unit_number integer not null,
  start_date date not null,
  end_date date,
  monthly_rent numeric not null default 0,
  status text not null default 'Active' check (status in ('Active','Pending','Expired','Renewal due')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete cascade,
  unit_id uuid references units(id) on delete set null,
  unit_number integer,
  amount numeric not null default 0,
  due_date date not null,
  paid_date date,
  status text not null default 'Outstanding' check (status in ('Paid','Outstanding','Overdue')),
  method text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete set null,
  unit_id uuid references units(id) on delete set null,
  unit_number integer,
  title text not null,
  description text,
  priority text not null default 'Medium' check (priority in ('Low','Medium','High')),
  status text not null default 'Open' check (status in ('Open','In progress','Scheduled','Resolved','Closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid,
  action text not null,
  actor_id uuid references users(id) on delete set null,
  details jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_units_property_id on units(property_id);
create index if not exists idx_tenants_property_id on tenants(property_id);
create index if not exists idx_tenants_unit_id on tenants(unit_id);
create index if not exists idx_leases_property_id on leases(property_id);
create index if not exists idx_payments_status on payments(status);
create index if not exists idx_maintenance_status on maintenance_requests(status);
create index if not exists idx_audit_logs_entity on audit_logs(entity_type, entity_id);

create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_updated_at_properties
before update on properties
for each row execute function update_updated_at_column();

create trigger set_updated_at_users
before update on users
for each row execute function update_updated_at_column();

create trigger set_updated_at_units
before update on units
for each row execute function update_updated_at_column();

create trigger set_updated_at_tenants
before update on tenants
for each row execute function update_updated_at_column();

create trigger set_updated_at_leases
before update on leases
for each row execute function update_updated_at_column();

create trigger set_updated_at_payments
before update on payments
for each row execute function update_updated_at_column();

create trigger set_updated_at_maintenance_requests
before update on maintenance_requests
for each row execute function update_updated_at_column();

-- Seed property
insert into properties (id, name, address, city, state, zip_code, floors)
values (
  '11111111-1111-1111-1111-111111111111'::uuid,
  'Riiroow Apartments',
  '1250 North Residence Blvd',
  'Dallas',
  'TX',
  '75204',
  5
)
on conflict do nothing;

-- Seed admin users
insert into users (id, name, email, password, role, permissions)
values
  ('22222222-2222-2222-2222-222222222221', 'Ava Thompson', 'admin@riiroow.com', 'admin123', 'Admin', '["all"]'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'Noah Smith', 'manager@riiroow.com', 'manager123', 'Manager', '["units","tenants","leases","dashboard"]'::jsonb),
  ('22222222-2222-2222-2222-222222222223', 'Emma Clark', 'accountant@riiroow.com', 'accountant123', 'Accountant', '["payments","rent","reports"]'::jsonb),
  ('22222222-2222-2222-2222-222222222224', 'Lucas King', 'maintenance@riiroow.com', 'maintenance123', 'Maintenance', '["maintenance","units"]'::jsonb)
on conflict (email) do nothing;

-- Seed units
insert into units (id, property_id, unit_number, floor, bedrooms, bathrooms, rent, status, occupancy, last_payment_date)
values
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111111'::uuid, 101, 1, 2, 2.0, 1850, 'occupied', 'Occupied', '2026-08-20'),
  ('33333333-3333-3333-3333-333333333302', '11111111-1111-1111-1111-111111111111'::uuid, 102, 1, 1, 1.0, 1500, 'occupied', 'Occupied', '2026-08-20'),
  ('33333333-3333-3333-3333-333333333303', '11111111-1111-1111-1111-111111111111'::uuid, 201, 2, 2, 2.0, 1900, 'occupied', 'Occupied', '2026-08-20'),
  ('33333333-3333-3333-3333-333333333304', '11111111-1111-1111-1111-111111111111'::uuid, 202, 2, 2, 2.0, 1950, 'occupied', 'Occupied', '2026-08-20'),
  ('33333333-3333-3333-3333-333333333305', '11111111-1111-1111-1111-111111111111'::uuid, 301, 3, 2, 2.0, 2000, 'occupied', 'Occupied', '2026-08-20'),
  ('33333333-3333-3333-3333-333333333306', '11111111-1111-1111-1111-111111111111'::uuid, 302, 3, 1, 1.0, 1650, 'occupied', 'Occupied', '2026-08-20'),
  ('33333333-3333-3333-3333-333333333307', '11111111-1111-1111-1111-111111111111'::uuid, 401, 4, 2, 2.0, 2050, 'occupied', 'Occupied', '2026-08-20'),
  ('33333333-3333-3333-3333-333333333308', '11111111-1111-1111-1111-111111111111'::uuid, 402, 4, 2, 2.0, 2100, 'occupied', 'Occupied', '2026-08-20'),
  ('33333333-3333-3333-3333-333333333309', '11111111-1111-1111-1111-111111111111'::uuid, 501, 5, 2, 2.0, 2200, 'occupied', 'Occupied', '2026-08-20'),
  ('33333333-3333-3333-3333-333333333310', '11111111-1111-1111-1111-111111111111'::uuid, 502, 5, 2, 2.0, 2250, 'occupied', 'Occupied', '2026-08-20')
on conflict do nothing;

-- Seed tenants
insert into tenants (id, property_id, name, email, phone, unit_id, unit_number, move_in_date, status)
values
  ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111111'::uuid, 'Alicia Gomez', 'alicia@riiroow.com', '(555) 111-0101', '33333333-3333-3333-3333-333333333301'::uuid, 101, '2025-01-15', 'Active'),
  ('44444444-4444-4444-4444-444444444402', '11111111-1111-1111-1111-111111111111'::uuid, 'Marcus Hill', 'marcus@riiroow.com', '(555) 111-0102', '33333333-3333-3333-3333-333333333302'::uuid, 102, '2025-02-01', 'Active'),
  ('44444444-4444-4444-4444-444444444403', '11111111-1111-1111-1111-111111111111'::uuid, 'Tara Nguyen', 'tara@riiroow.com', '(555) 111-0201', '33333333-3333-3333-3333-333333333303'::uuid, 201, '2024-11-10', 'Active'),
  ('44444444-4444-4444-4444-444444444404', '11111111-1111-1111-1111-111111111111'::uuid, 'Daniel Brooks', 'daniel@riiroow.com', '(555) 111-0202', '33333333-3333-3333-3333-333333333304'::uuid, 202, '2025-03-05', 'Active'),
  ('44444444-4444-4444-4444-444444444405', '11111111-1111-1111-1111-111111111111'::uuid, 'Priya Shah', 'priya@riiroow.com', '(555) 111-0301', '33333333-3333-3333-3333-333333333305'::uuid, 301, '2024-08-22', 'Active'),
  ('44444444-4444-4444-4444-444444444406', '11111111-1111-1111-1111-111111111111'::uuid, 'Evan Foster', 'evan@riiroow.com', '(555) 111-0302', '33333333-3333-3333-3333-333333333306'::uuid, 302, '2025-04-09', 'Active'),
  ('44444444-4444-4444-4444-444444444407', '11111111-1111-1111-1111-111111111111'::uuid, 'Monica Lee', 'monica@riiroow.com', '(555) 111-0401', '33333333-3333-3333-3333-333333333307'::uuid, 401, '2024-12-17', 'Active'),
  ('44444444-4444-4444-4444-444444444408', '11111111-1111-1111-1111-111111111111'::uuid, 'Oscar Reed', 'oscar@riiroow.com', '(555) 111-0402', '33333333-3333-3333-3333-333333333308'::uuid, 402, '2025-01-29', 'Active'),
  ('44444444-4444-4444-4444-444444444409', '11111111-1111-1111-1111-111111111111'::uuid, 'Julia Park', 'julia@riiroow.com', '(555) 111-0501', '33333333-3333-3333-3333-333333333309'::uuid, 501, '2025-05-11', 'Active'),
  ('44444444-4444-4444-4444-444444444410', '11111111-1111-1111-1111-111111111111'::uuid, 'Samir Patel', 'samir@riiroow.com', '(555) 111-0502', '33333333-3333-3333-3333-333333333310'::uuid, 502, '2024-10-03', 'Active')
on conflict do nothing;

-- Seed leases
insert into leases (id, property_id, tenant_id, unit_id, unit_number, start_date, end_date, monthly_rent, status)
values
  ('55555555-5555-5555-5555-555555555501', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444401'::uuid, '33333333-3333-3333-3333-333333333301'::uuid, 101, '2025-01-15', '2026-01-14', 1850, 'Active'),
  ('55555555-5555-5555-5555-555555555502', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444402'::uuid, '33333333-3333-3333-3333-333333333302'::uuid, 102, '2025-02-01', '2026-02-01', 1500, 'Active'),
  ('55555555-5555-5555-5555-555555555503', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444403'::uuid, '33333333-3333-3333-3333-333333333303'::uuid, 201, '2024-11-10', '2025-11-09', 1900, 'Active'),
  ('55555555-5555-5555-5555-555555555504', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444404'::uuid, '33333333-3333-3333-3333-333333333304'::uuid, 202, '2025-03-05', '2026-03-04', 1950, 'Active'),
  ('55555555-5555-5555-5555-555555555505', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444405'::uuid, '33333333-3333-3333-3333-333333333305'::uuid, 301, '2024-08-22', '2025-08-21', 2000, 'Renewal due'),
  ('55555555-5555-5555-5555-555555555506', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444406'::uuid, '33333333-3333-3333-3333-333333333306'::uuid, 302, '2025-04-09', '2026-04-08', 1650, 'Active'),
  ('55555555-5555-5555-5555-555555555507', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444407'::uuid, '33333333-3333-3333-3333-333333333307'::uuid, 401, '2024-12-17', '2025-12-16', 2050, 'Active'),
  ('55555555-5555-5555-5555-555555555508', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444408'::uuid, '33333333-3333-3333-3333-333333333308'::uuid, 402, '2025-01-29', '2026-01-28', 2100, 'Active'),
  ('55555555-5555-5555-5555-555555555509', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444409'::uuid, '33333333-3333-3333-3333-333333333309'::uuid, 501, '2025-05-11', '2026-05-10', 2200, 'Active'),
  ('55555555-5555-5555-5555-555555555510', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444410'::uuid, '33333333-3333-3333-3333-333333333310'::uuid, 502, '2024-10-03', '2025-10-02', 2250, 'Active')
on conflict do nothing;

-- Seed payments
insert into payments (id, property_id, tenant_id, unit_id, unit_number, amount, due_date, paid_date, status, method)
values
  ('66666666-6666-6666-6666-666666666601', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444401'::uuid, '33333333-3333-3333-3333-333333333301'::uuid, 101, 1850, '2026-08-01', '2026-08-02', 'Paid', 'ACH'),
  ('66666666-6666-6666-6666-666666666602', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444402'::uuid, '33333333-3333-3333-3333-333333333302'::uuid, 102, 1500, '2026-08-01', '2026-08-10', 'Paid', 'Card'),
  ('66666666-6666-6666-6666-666666666603', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444403'::uuid, '33333333-3333-3333-3333-333333333303'::uuid, 201, 1900, '2026-08-01', null, 'Overdue', 'ACH'),
  ('66666666-6666-6666-6666-666666666604', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444404'::uuid, '33333333-3333-3333-3333-333333333304'::uuid, 202, 1950, '2026-08-01', null, 'Outstanding', 'Bank transfer'),
  ('66666666-6666-6666-6666-666666666605', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444405'::uuid, '33333333-3333-3333-3333-333333333305'::uuid, 301, 2000, '2026-08-01', '2026-08-05', 'Paid', 'ACH'),
  ('66666666-6666-6666-6666-666666666606', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444406'::uuid, '33333333-3333-3333-3333-333333333306'::uuid, 302, 1650, '2026-08-01', null, 'Outstanding', 'Card'),
  ('66666666-6666-6666-6666-666666666607', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444407'::uuid, '33333333-3333-3333-3333-333333333307'::uuid, 401, 2050, '2026-08-01', '2026-08-01', 'Paid', 'ACH'),
  ('66666666-6666-6666-6666-666666666608', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444408'::uuid, '33333333-3333-3333-3333-333333333308'::uuid, 402, 2100, '2026-08-01', null, 'Overdue', 'Check'),
  ('66666666-6666-6666-6666-666666666609', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444409'::uuid, '33333333-3333-3333-3333-333333333309'::uuid, 501, 2200, '2026-08-01', '2026-08-04', 'Paid', 'ACH'),
  ('66666666-6666-6666-6666-666666666610', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444410'::uuid, '33333333-3333-3333-3333-333333333310'::uuid, 502, 2250, '2026-08-01', null, 'Outstanding', 'Card')
on conflict do nothing;

-- Seed maintenance requests
insert into maintenance_requests (id, property_id, tenant_id, unit_id, unit_number, title, description, priority, status)
values
  ('77777777-7777-7777-7777-777777777701', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444403'::uuid, '33333333-3333-3333-3333-333333333303'::uuid, 201, 'HVAC not cooling', 'Air conditioner is running but not cooling the living room', 'High', 'In progress'),
  ('77777777-7777-7777-7777-777777777702', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444406'::uuid, '33333333-3333-3333-3333-333333333306'::uuid, 302, 'Leaking kitchen sink', 'Drain pipe is leaking beneath sink cabinet', 'Medium', 'Open'),
  ('77777777-7777-7777-7777-777777777703', '11111111-1111-1111-1111-111111111111'::uuid, '44444444-4444-4444-4444-444444444410'::uuid, '33333333-3333-3333-3333-333333333310'::uuid, 502, 'Light fixture replacement', 'Bathroom vanity light flickers after power surge', 'Low', 'Scheduled')
on conflict do nothing;
