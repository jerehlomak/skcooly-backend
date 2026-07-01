const generateOtpEmailTemplate = (otpCode, name) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Your Skooly Plus Security Code</title>
    <style>
        body { font-family: 'Inter', Helvetica, Arial, sans-serif; background-color: #f4f7f6; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.05); }
        .header { background-color: #1a365d; padding: 30px; text-align: center; }
        .header img { max-height: 50px; }
        .content { padding: 40px; color: #333333; line-height: 1.6; }
        .greeting { font-size: 20px; font-weight: 600; margin-bottom: 20px; color: #1a365d; }
        .otp-container { text-align: center; margin: 30px 0; }
        .otp-code { display: inline-block; font-size: 36px; font-weight: 700; color: #2563eb; letter-spacing: 6px; padding: 15px 30px; background-color: #eff6ff; border-radius: 8px; border: 2px dashed #bfdbfe; }
        .warning { font-size: 14px; color: #6b7280; margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 20px; text-align: center; }
        .footer { background-color: #f9fafb; padding: 20px; text-align: center; font-size: 12px; color: #9ca3af; border-top: 1px solid #e5e7eb; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <!-- Using an inline SVG or a placeholder logo for Skooly Plus. Ideally, host this logo on a CDN or use an absolute URL from your server. -->
            <h1 style="color: white; margin: 0; font-size: 24px; font-weight: bold; letter-spacing: 1px;">Skooly<span style="color: #60a5fa;">Plus</span></h1>
        </div>
        <div class="content">
            <div class="greeting">Hello ${name || 'Admin'},</div>
            <p>You have requested to authenticate with the Skooly Plus Central Admin dashboard. Please use the verification code below to complete your process.</p>
            
            <div class="otp-container">
                <div class="otp-code">${otpCode}</div>
            </div>
            
            <p>This code will expire in 10 minutes. If you did not request this code, please ignore this email or contact support if you have concerns.</p>
            
            <div class="warning">
                Security Tip: Never share this code with anyone. Skooly Plus staff will never ask for your verification code.
            </div>
        </div>
        <div class="footer">
            &copy; ${new Date().getFullYear()} Skooly Plus. All rights reserved.<br>
            Secure Authentication System
        </div>
    </div>
</body>
</html>
`;

module.exports = {
    generateOtpEmailTemplate
};
