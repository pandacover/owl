import { randomBytes } from "node:crypto"

// No vowels or look-alike characters, so ids never spell words and are easy to read back.
const ALPHABET = "23456789bcdfghjkmnpqrstvwxyz"

export const randomCode = (length: number): string => {
  const bytes = randomBytes(length)
  let out = ""
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}

/** Ids like m_7kq2xd (media), p_4hz9tc (project), r_... (render). */
export const newId = (prefix: string): string => `${prefix}_${randomCode(6)}`
