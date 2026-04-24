import { google } from '@ai-sdk/google';

async function list() {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_GENERATIVE_AI_API_KEY}`);
    const data = await res.json();
    console.log(data.models.map(m => m.name));
}

list();
