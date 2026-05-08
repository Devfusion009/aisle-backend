import axios from 'axios';
async function run() {
  try {
    const res = await axios.post('http://localhost:3000/api/auth/login', {
      email: 'admin@example.com',
      password: 'password123'
    });
    console.log(res.data);
  } catch (err) {
    if (err.response) console.log(err.response.data);
  }
}
run();
