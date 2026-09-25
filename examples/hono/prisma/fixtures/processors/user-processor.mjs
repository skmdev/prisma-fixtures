import { argon2id, hash } from 'argon2'

export default class UserProcessor {
  async preProcess(_name, user) {
    return { ...user, password: await hash(user.password, { type: argon2id }) }
  }
}
