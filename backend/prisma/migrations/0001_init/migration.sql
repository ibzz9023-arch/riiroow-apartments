-- SQL migration for initial schema
-- This mirrors the Prisma schema; if you use `prisma migrate` the exact SQL may differ.

CREATE TABLE "Role" (
  id serial PRIMARY KEY,
  name varchar(255) UNIQUE NOT NULL,
  "createdAt" timestamptz DEFAULT now()
);

CREATE TABLE "Property" (
  id serial PRIMARY KEY,
  name varchar(255) NOT NULL,
  "createdAt" timestamptz DEFAULT now()
);

CREATE TABLE "Unit" (
  id serial PRIMARY KEY,
  number varchar(255) NOT NULL,
  "propertyId" integer REFERENCES "Property"(id) ON DELETE CASCADE,
  "createdAt" timestamptz DEFAULT now()
);

CREATE TABLE "User" (
  id serial PRIMARY KEY,
  email varchar(255) UNIQUE NOT NULL,
  password varchar(255) NOT NULL,
  name varchar(255),
  "roleId" integer REFERENCES "Role"(id),
  "totpSecret" varchar(255),
  "createdAt" timestamptz DEFAULT now(),
  "updatedAt" timestamptz DEFAULT now()
);

CREATE TABLE "AuditLog" (
  id serial PRIMARY KEY,
  "userId" integer REFERENCES "User"(id),
  action varchar(255) NOT NULL,
  resource varchar(255) NOT NULL,
  ip varchar(255),
  meta jsonb,
  "createdAt" timestamptz DEFAULT now()
);
