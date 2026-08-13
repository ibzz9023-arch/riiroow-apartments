import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcrypt'
import dotenv from 'dotenv'

dotenv.config()

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding database...')

  const roles = ['admin', 'manager', 'resident']
  for (const r of roles) {
    await prisma.role.upsert({ where: { name: r }, update: {}, create: { name: r } })
  }

  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@riiroow.local'
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'StrongP@ssw0rd!'
  const hashed = await bcrypt.hash(adminPassword, 10)

  const adminRole = await prisma.role.findUnique({ where: { name: 'admin' } })
  if (!adminRole) throw new Error('admin role not found')

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: { password: hashed, roleId: adminRole.id },
    create: { email: adminEmail, password: hashed, roleId: adminRole.id, name: 'Administrator' }
  })

  const property = await prisma.property.upsert({
    where: { name: 'Riiroow' },
    update: {},
    create: { name: 'Riiroow' }
  })

  const unitNumbers = ['101','102','201','202','301','302','401','402','501','502']
  for (const n of unitNumbers) {
    await prisma.unit.upsert({
      where: { number_propertyId: { number: n, propertyId: property.id } },
      update: {},
      create: { number: n, propertyId: property.id }
    })
  }

  console.log('Seeding complete. Admin:', adminEmail)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
