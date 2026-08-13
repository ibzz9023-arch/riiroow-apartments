import express from 'express'
import cors from 'cors'
import pino from 'pino'
import pinoHttp from 'pino-http'
import dotenv from 'dotenv'
import routes from './routes'
import { errorHandler } from './middleware/errorHandler'
import { auditMiddleware } from './middleware/auditLogger'

dotenv.config()

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })
const app = express()

app.use(cors())
app.use(express.json())
app.use(pinoHttp({ logger }))
app.use(auditMiddleware)

app.use('/api', routes)

app.use(errorHandler)

export default app
