import express from 'express'
import prisma from '../prismaClient'
import { authMiddleware } from '../middleware/auth'
import { permit } from '../middleware/roles'
import { z } from 'zod'

const router = express.Router()

router.get('/', async (req, res) => {
  const properties = await prisma.property.findMany({ include: { units: true } })
  res.json(properties)
})

router.post('/', authMiddleware, permit('admin','manager'), async (req, res) => {
  const schema = z.object({ name: z.string().min(1) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors })
  const prop = await prisma.property.create({ data: { name: parsed.data.name } })
  res.json(prop)
})

export default router
