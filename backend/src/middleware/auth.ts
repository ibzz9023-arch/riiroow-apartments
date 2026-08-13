import { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt'
import prisma from '../prismaClient'

export interface AuthedRequest extends Request {
  user?: any
}

export async function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  const token = auth.split(' ')[1]
  const payload: any = verifyToken(token)
  if (!payload?.sub) return res.status(401).json({ error: 'Invalid token' })

  const user = await prisma.user.findUnique({ where: { id: Number(payload.sub) }, include: { role: true } })
  if (!user) return res.status(401).json({ error: 'User not found' })
  req.user = user
  next()
}
