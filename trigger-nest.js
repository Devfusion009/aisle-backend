const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/app.module');
const { ChatService } = require('./dist/modules/conversations/chat.service');

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const chatService = app.get(ChatService);
  
  // Find a conversation
  const { ConversationsService } = require('./dist/modules/conversations/conversations.service');
  const conversationsService = app.get(ConversationsService);
  
  // Just query the DB directly to find any active conversation
  const { getConnection } = require('typeorm');
  
  try {
     const pool = require('pg').Pool;
     const p = new pool({user:'aisle', password: 'aisle_secret', database:'aisle_db', host:'localhost', port:5433});
     const chatRows = await p.query('SELECT c.id, c."tenantId", c."userId" FROM conversations c JOIN assistants a ON c."assistantId" = a.id WHERE a.provider = \'mistral\' LIMIT 1;');
     if(chatRows.rows.length === 0) return console.log('no conversation found');
     
     const conv = chatRows.rows[0];
     
     const tenant = { tenantId: conv.tenantId, userId: conv.userId, role: 'user' };
     const dto = { message: "Hello again" };
     console.log("Chatting with", conv.id, "as tenant", tenant.tenantId);
     
     await chatService.chat(tenant, conv.id, dto);
     console.log('Success');
  } catch(e) {
     console.error("FAIL:", e);
  } finally {
    app.close();
  }
}
bootstrap();
