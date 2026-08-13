import bcrypt from 'bcrypt'

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 10)
}

export async function comparePassword(plain: string, hash: string) {
  return bcrypt.compare(plain, hash)
}
