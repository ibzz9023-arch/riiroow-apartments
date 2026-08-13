import express from 'express'
import authRoutes from './routes/auth'
import userRoutes from './routes/users'
import propertyRoutes from './routes/properties'
import unitRoutes from './routes/units'

const router = express.Router()

router.use('/auth', authRoutes)
router.use('/users', userRoutes)
router.use('/properties', propertyRoutes)
router.use('/units', unitRoutes)

export default router
