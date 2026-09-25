import 'reflect-metadata'
import { Controller, Get, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { prisma } from '../prisma/client'

@Controller('api/users')
class UsersController {
  @Get()
  users() {
    return prisma.user.findMany({
      select: { id: true, email: true, name: true, posts: true },
      orderBy: { id: 'asc' },
    })
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
