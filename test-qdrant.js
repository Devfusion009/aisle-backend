import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

async function main() {
  const qdrant = new QdrantClient({ url: 'http://localhost:6333' });
  const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' });
  
  const query = 'What is the multi-tenant saas platform?';
  const res = await client.embeddings.create({ model: 'openai/text-embedding-3-small', input: query });
  const vector = res.data[0].embedding;

  const results = await qdrant.search('documents', {
    vector,
    limit: 5,
    with_payload: true,
  });

  console.log(`Scores for "${query}":`);
  results.forEach(r => console.log(`- Score: ${r.score} Content: ${r.payload.content.substring(0, 50)}...`));
}

main().catch(console.error);
