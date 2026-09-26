import 'reflect-metadata'
import { Controller, Get, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { db } from '../prisma/client'

@Controller('api/users')
class UsersController {
  @Get()
  users() {
    return db.orm.public.User.include('posts')
      .select('id', 'email', 'name')
      .orderBy((user) => user.id.asc())
      .all()
  }
}

@Module({ controllers: [UsersController] })
class AppModule {}

async function main() {
  const app = await NestFactory.create(AppModule)
  await app.listen(Number(process.env.PORT ?? 3000), '127.0.0.1')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
