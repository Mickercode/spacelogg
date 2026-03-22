const { Resend } = require('resend');

let resendClient = null;

function getClient() {
  if (!resendClient && process.env.RESEND_API_KEY) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

async function sendEmail({ to, subject, html, text }) {
  const client = getClient();
  const from   = process.env.RESEND_FROM || 'SpaceLogg <onboarding@resend.dev>';

  if (!client) {
    console.log('\n📧 [DEV - no RESEND_API_KEY set, email not sent]');
    console.log(`  To: ${to}\n  Subject: ${subject}\n`);
    return { id: 'dev-mode' };
  }

  try {
    const { data, error } = await client.emails.send({ from, to, subject, html, text });
    if (error) {
      console.error('Resend error:', error);
      throw new Error(error.message);
    }
    console.log(`✅ Email sent to ${to} (id: ${data?.id})`);
    return data;
  } catch (err) {
    console.error('Email failed:', err.message);
    // Don't crash the app if email fails
    return null;
  }
}

function emailTemplate({ title, body, ctaText, ctaUrl }) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/>
<style>
  body{font-family:sans-serif;background:#F5EDD8;margin:0;padding:20px;}
  .wrap{max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;}
  .header{background:#1C1A16;padding:24px 32px;}
  .logo{font-family:Georgia,serif;font-size:22px;color:#F5EDD8;text-decoration:none;}
  .logo span{color:#E8891A;}
  .body{padding:32px;}
  h1{font-family:Georgia,serif;font-size:26px;color:#1C1A16;margin:0 0 16px;}
  p{font-size:15px;color:#6B6456;line-height:1.65;margin:0 0 16px;}
  .cta{display:inline-block;background:#E8891A;color:#1C1A16;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:600;font-size:15px;margin-top:8px;}
  .footer{background:#F5EDD8;padding:20px 32px;font-size:12px;color:#9C8F78;text-align:center;}
  a{color:#E8891A;}
</style>
</head>
<body>
<div class="wrap">
  <div class="header"><a href="${appUrl}" class="logo">Space<span>Logg</span></a></div>
  <div class="body">
    <h1>${title}</h1>
    ${body}
    ${ctaText && ctaUrl ? `<br/><a href="${ctaUrl}" class="cta">${ctaText}</a>` : ''}
  </div>
  <div class="footer">
    © 2025 SpaceLogg · <a href="${appUrl}">${appUrl.replace('https://','')}</a><br/>
    You're receiving this because you have an account on SpaceLogg.
  </div>
</div>
</body>
</html>`;
}

module.exports = { sendEmail, emailTemplate };
