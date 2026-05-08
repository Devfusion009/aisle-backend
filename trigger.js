// Login and trigger chat
async function run() {
  try {
    let res = await fetch('http://localhost:3000/api/auth/login', {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "password123" })
    });
    if (!res.ok) {
      console.log('Login failed', await res.text());
      return;
    }
    const { accessToken, user } = await res.json();
    console.log('Logged in', accessToken.substring(0,20));

    // Get conversations
    res = await fetch('http://localhost:3000/api/conversations', {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    const convs = await res.json();
    if (!convs.length) {
      console.log("No conversations found");
      return;
    }

    const conversationId = convs[0].id;
    console.log('Using conversation', conversationId);

    // trigger chat
    res = await fetch(`http://localhost:3000/api/conversations/${conversationId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
      body: JSON.stringify({ message: "Hello Mistral!" })
    });
    console.log('Status:', res.status);
    console.log(await res.text());

  } catch (err) {
    console.error(err);
  }
}
run();
