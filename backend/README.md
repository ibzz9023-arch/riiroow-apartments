# Backend README (short)

This folder contains the backend for the Riiroow Apartments project.

Main commands (from repository root):

- Install dependencies: (cd backend && npm install)
- Generate Prisma client: npx prisma generate
- Run migrations: npx prisma migrate dev --name init --preview-feature
- Seed database: npm run prisma:seed
- Start dev server: npm run dev

Docker Compose:
- docker compose up --build

Notes:
- The project uses Node.js + TypeScript + Express + Prisma(PG), JWT auth, bcrypt, Zod, pino.
- The seed creates roles (admin, manager, resident), an admin user, and a Property named "Riiroow" with units 101,102,201,202,301,302,401,402,501,502.
