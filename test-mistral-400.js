import OpenAI from "openai";

async function test() {
  const mistralKey = "";
  
  const client = new OpenAI({
    apiKey: mistralKey,
    baseURL: "https://api.mistral.ai/v1",
  });

  try {
    const res = await client.chat.completions.create({
      model: "mistral-small-latest",
      messages: [
        {role: "system", content: "You are a helpful assistant."},
        {role: "system", content: "Previous conversation summary: none"},
        {role: "user", content: "hello"}
      ],
      temperature: 0.7,
      max_tokens: 2048,
      top_p: 1,
    });
    console.log("Success! Output:", res.choices[0].message.content);
  } catch (err) {
    if (err.response) {
      console.log("Error data:", JSON.stringify(err.response.data, null, 2));
    } else if (err.error) {
      console.log("Error property:", JSON.stringify(err.error, null, 2));
    } else {
      console.log("Error:", err);
    }
  }
}

test();
