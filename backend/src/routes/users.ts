import express from 'express'
import prisma from '../prismaClient'
import { authMiddleware } from '../middleware/auth'
import { permit } from '../middleware/roles'

const router = express.Router()

router.use(authMiddleware)

router.get('/', permit('admin','manager'), async (req, res) => {
  const users = await prisma.user.findMany({ include: { role: true } })
  res.json(users)
})

router.get('/me', async (req: any, res) => {
  res.json(req.user)
})

export default router
