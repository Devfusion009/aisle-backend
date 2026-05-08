import OpenAI from "openai";

async function test() {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) { console.log('No token'); return;}
  
  const client = new OpenAI({
    apiKey: openrouterKey,
    baseURL: "https://openrouter.ai/api/v1",
  });

  try {
    const start = Date.now();
    const res = await client.embeddings.create({
      model: "openai/text-embedding-3-small",
      input: "test query",
    });
    console.log("Success! Dimensions:", res.data[0].embedding.length, "Time:", Date.now() - start);
  } catch (err) {
    console.error("OpenRouter error:", err.message);
  }
}

test();
