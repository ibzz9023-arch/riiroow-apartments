import express from 'express'
import prisma from '../prismaClient'
import { z } from 'zod'

const router = express.Router()

router.get('/', async (req, res) => {
  const units = await prisma.unit.findMany({ include: { property: true } })
  res.json(units)
})

router.post('/', async (req, res) => {
  const schema = z.object({ number: z.string(), propertyId: z.number() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors })
  const unit = await prisma.unit.create({ data: { number: parsed.data.number, propertyId: parsed.data.propertyId } })
  res.json(unit)
})

export default router
