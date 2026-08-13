import { Request, Response, NextFunction } from 'express'
import prisma from '../prismaClient'

export async function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  res.on('finish', async () => {
    try {
      const userId = (req as any).user?.id ?? null
      await prisma.auditLog.create({ data: {
        userId: userId,
        action: req.method,
        resource: req.originalUrl,
        ip: req.ip,
        meta: { status: res.statusCode }
      }})
    } catch (e) {
      // don't block on audit failures
      console.warn('Audit log failed', e)
    }
  })
  next()
}
