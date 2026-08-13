import { Request, Response, NextFunction } from 'express'
import { AuthedRequest } from './auth'

export function permit(...allowedRoles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const role = req.user?.role?.name
    if (!role || !allowedRoles.includes(role)) return res.status(403).json({ error: 'Forbidden' })
    next()
  }
}
