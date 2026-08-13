import express from 'express'
import { z } from 'zod'
import prisma from '../prismaClient'
import { signToken } from '../utils/jwt'
import { comparePassword, hashPassword } from '../utils/password'

const router = express.Router()

const registerSchema = z.object({ email: z.string().email(), password: z.string().min(8), name: z.string().optional() })
const loginSchema = z.object({ email: z.string().email(), password: z.string() })

router.post('/register', async (req, res) => {
  const parse = registerSchema.safeParse(req.body)
  if (!parse.success) return res.status(400).json({ error: parse.error.errors })
  const { email, password, name } = parse.data
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) return res.status(400).json({ error: 'Email already in use' })
  const hashed = await hashPassword(password)
  const residentRole = await prisma.role.findUnique({ where: { name: 'resident' } })
  const user = await prisma.user.create({ data: { email, password: hashed, name, roleId: residentRole?.id } })
  res.json({ id: user.id, email: user.email })
})

router.post('/login', async (req, res) => {
  const parse = loginSchema.safeParse(req.body)
  if (!parse.success) return res.status(400).json({ error: parse.error.errors })
  const { email, password } = parse.data
  const user = await prisma.user.findUnique({ where: { email }, include: { role: true } })
  if (!user) return res.status(401).json({ error: 'Invalid credentials' })
  const ok = await comparePassword(password, user.password)
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' })
  const token = signToken({ sub: String(user.id) })
  res.json({ token, user: { id: user.id, email: user.email, role: user.role?.name } })
})

export default router
