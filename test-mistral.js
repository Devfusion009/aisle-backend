import OpenAI from "openai";
async function test() {
  const client = new OpenAI({
    apiKey: "",
    baseURL: "https://api.mistral.ai/v1",
  });
  try {
    const res = await client.chat.completions.create({
      model: "mistral-small-latest",
      messages: [
        {role: "system", content: "hello"},
        {role: "assistant", content: "I am an assistant"},
        {role: "user", content: "Say hello"}
      ]
    });
    console.log("Success! Output:", res.choices[0].message.content);
  } catch (err) {
    if (err.response) { console.error("Mistral error mapping:", err.response.data); }
  }
}
test();
