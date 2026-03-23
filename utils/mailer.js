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
  const iconUrl = `${appUrl}/branding/spacelogg-icon-128.png`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#F5EDD8;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5EDD8;min-height:100vh;">
  <tr><td align="center" style="padding:48px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;">

      <tr><td align="center" style="padding-bottom:20px;">
        <img src="${iconUrl}" alt="SpaceLogg" width="56" height="56" style="border-radius:14px;display:block;"/>
      </td></tr>

      <tr><td style="background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 2px 24px rgba(28,26,22,0.08);">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="background:#1C1A16;padding:24px 40px;">
            <span style="font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#F5EDD8;">Space<span style="color:#E8891A;">Logg</span></span>
          </td></tr>
          <tr><td style="background:#E8891A;height:3px;line-height:3px;font-size:1px;">&nbsp;</td></tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="padding:40px 40px 32px;">
            <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;color:#1C1A16;margin:0 0 20px;line-height:1.25;font-weight:normal;">${title}</h1>
            ${body}
            ${ctaText && ctaUrl ? `
            <table cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;">
              <tr><td style="background:#E8891A;border-radius:12px;">
                <a href="${ctaUrl}" style="display:inline-block;padding:14px 32px;color:#1C1A16;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-weight:600;font-size:15px;">${ctaText} &rarr;</a>
              </td></tr>
            </table>` : ''}
          </td></tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="padding:0 40px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="border-top:1px solid #F0E8D8;padding-top:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#9C8F78;line-height:1.8;">
                &copy; 2025 SpaceLogg &middot; <a href="${appUrl}" style="color:#E8891A;text-decoration:none;">spacelogg.com</a><br/>
                You&rsquo;re receiving this because you have an account on SpaceLogg.
              </td></tr>
            </table>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function welcomeEmail(name) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const firstName = name.split(' ')[0];
  return emailTemplate({
    title: `Welcome aboard, ${firstName}!`,
    body: `
      <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 20px;">
        You've joined a growing community of remote workers, freelancers, and digital nomads who use SpaceLogg to find their perfect workspace.
      </p>
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr><td style="background:#FDF8F0;border-radius:12px;padding:14px 18px;border-left:3px solid #E8891A;">
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1C1A16;margin:0;font-weight:500;">&#9749; &nbsp;Browse cafés, coworking spaces, libraries &amp; hotel lounges</p>
        </td></tr>
        <tr><td style="height:8px;"></td></tr>
        <tr><td style="background:#FDF8F0;border-radius:12px;padding:14px 18px;border-left:3px solid #E8891A;">
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1C1A16;margin:0;font-weight:500;">&#128205; &nbsp;Explore spaces on an interactive map &amp; book your spot</p>
        </td></tr>
        <tr><td style="height:8px;"></td></tr>
        <tr><td style="background:#FDF8F0;border-radius:12px;padding:14px 18px;border-left:3px solid #E8891A;">
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1C1A16;margin:0;font-weight:500;">&#11088; &nbsp;Save favourites and share reviews with the community</p>
        </td></tr>
      </table>
      <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:20px 0 0;">
        Ready to find your next workspace?
      </p>
    `,
    ctaText: 'Start Exploring',
    ctaUrl: `${appUrl}/dashboard.html`
  });
}

module.exports = { sendEmail, emailTemplate, welcomeEmail };
