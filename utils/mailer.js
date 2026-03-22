const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

async function sendEmail({ to, subject, html, text }) {
  if (!resend) {
    // Dev mode — log to console if no API key set
    console.log('\n📧 [DEV EMAIL — set RESEND_API_KEY in .env to send real emails]');
    console.log(`To: ${to}\nSubject: ${subject}\n`);
    return;
  }

  const from = process.env.RESEND_FROM || 'SpaceLogg <onboarding@resend.dev>';

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject,
    html,
    text
  });

  if (error) {
    console.error('Resend error:', error);
    throw new Error(error.message);
  }

  return data;
}

// Branded HTML email template
function emailTemplate({ title, body, ctaText, ctaUrl }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/>
<style>
  body{font-family:sans-serif;background:#F5EDD8;margin:0;padding:0;}
  .wrap{max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;}
  .header{background:#1C1A16;padding:24px 32px;}
  .logo{font-family:serif;font-size:22px;color:#F5EDD8;}
  .logo span{color:#E8891A;}
  .body{padding:32px;}
  h1{font-family:serif;font-size:26px;color:#1C1A16;margin:0 0 12px;}
  p{font-size:15px;color:#6B6456;line-height:1.65;margin:0 0 16px;}
  .cta{display:inline-block;background:#E8891A;color:#1C1A16;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:600;font-size:15px;margin-top:8px;}
  .footer{background:#F5EDD8;padding:20px 32px;font-size:12px;color:#9C8F78;text-align:center;}
</style>
</head>
<body>
  <div class="wrap">
    <div class="header"><div class="logo">Space<span>Logg</span></div></div>
    <div class="body">
      <h1>${title}</h1>
      ${body}
      ${ctaText && ctaUrl ? `<a href="${ctaUrl}" class="cta">${ctaText}</a>` : ''}
    </div>
    <div class="footer">© 2025 SpaceLogg · <a href="${process.env.APP_URL || 'http://localhost:3000'}" style="color:#9C8F78;">spacelogg.com</a></div>
  </div>
</body>
</html>`;
}

module.exports = { sendEmail, emailTemplate };
