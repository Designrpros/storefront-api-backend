require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const nodemailer = require('nodemailer');
// Assuming you've initialized Firebase Admin SDK correctly somewhere above this line
const admin = require('firebase-admin');
const { db } = require('./firebaseAdmin');
const {google} = require('googleapis');

console.log("Stripe Secret Key:", process.env.STRIPE_SECRET_KEY);

const app = express();

app.use(cors());

// Apply JSON middleware globally except for the webhook route
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// OAuth2 client setup
const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

async function sendMail(email, subject, message) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER, // Your Gmail address
      pass: process.env.GMAIL_APP_PASSWORD // Your App Password
    }
  });

  const mailOptions = {
    from: `Høl i CVen <${process.env.GMAIL_USER}>`, // Sender address
    to: email, // List of recipients
    subject: subject, // Subject line
    text: message, // Plain text body
    html: `<p>${message}</p>`, // HTML body
  };

  try {
    const result = await transporter.sendMail(mailOptions);
    console.log('Email sent:', result);
    return result;
  } catch (error) {
    console.error('Failed to send email', error);
  }
}


app.post('/create-checkout-session', async (req, res) => {
  console.log("Received request for checkout session creation:", req.body);

  const { cartItems, shippingDetails } = req.body;

  const lineItems = cartItems.map(item => {
    const priceMatch = item.price.match(/(\d+([.,]\d+)?)/);
    let priceInCents = 0;
    if (priceMatch) {
      const priceAsNumber = parseFloat(priceMatch[0].replace(',', '.'));
      priceInCents = Math.round(priceAsNumber * 100);
    }

    return {
      price_data: {
        currency: 'nok',
        product_data: {
          name: item.name,
        },
        unit_amount: priceInCents,
      },
      quantity: item.quantity,
    };
  });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${req.headers.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/cancel`,
      shipping_address_collection: {
        allowed_countries: ['NO'],
      },
      // Removed shipping_rates for simplicity, add it back if you have specific rates
      metadata: {
        customerEmail: shippingDetails.email,
      },
    });

    console.log("Stripe session created:", session);
    res.json({ id: session.id });
  } catch (error) {
    console.error("Error creating Stripe checkout session:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/webhook', express.raw({type: 'application/json'}), async (request, response) => {
  const sig = request.headers['stripe-signature'];

  let event;

  try {
      event = stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
      console.error(`Webhook signature verification failed.`, err.message);
      return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Get the order ID from the metadata
    const orderId = session.metadata.orderId;

    // Construct the email message for the customer
    let customerEmailMessage = `Thank you for your order!\n`;
    customerEmailMessage += `Your order number is: ${orderId}\n`;
    customerEmailMessage += `\n`;
    customerEmailMessage += `Here's a summary of your order:\n`;

    // Loop through each line item in the session and add product details
    for (const item of session.line_items) {
      customerEmailMessage += `- ${item.quantity} x ${item.price_data.product_data.name}\n`;
    }

    // Send email to the customer
    await sendMail(session.customer_details.email, "Order Confirmation", customerEmailMessage);

    // Construct the email message for the shop owner
    let shopOwnerEmailMessage = `New order received!\n`;
    shopOwnerEmailMessage += `Order number: ${orderId}\n`;
    shopOwnerEmailMessage += `Customer email: ${session.customer_details.email}\n`;
    shopOwnerEmailMessage += `\n`;
    shopOwnerEmailMessage += `Here's a summary of the order:\n`;

    // Loop through each line item in the session and add product details
    for (const item of session.line_items) {
      shopOwnerEmailMessage += `- ${item.quantity} x ${item.price_data.product_data.name}\n`;
    }

    // Send email to the shop owner
    await sendMail("designr.pros@gmail.com", "New Order Received", shopOwnerEmailMessage);

    console.log('Checkout session completed:', session.id);
} else {
    console.warn(`Unhandled event type ${event.type}`);
}

response.json({received: true});
});

// Add this route to your server.js
app.get('/auth', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/gmail.send'
  ];

  const url = oAuth2Client.generateAuthUrl({
    // 'online' (default) or 'offline' (gets refresh_token)
    access_type: 'offline',

    // If you only need one scope you can pass it as a string
    scope: scopes,

    // Enable the "prompt" parameter to "consent" to ensure you get a refresh token
    prompt: 'consent'
  });

  console.log('Visit the url for the auth dialog: ', url);
  res.send(`Visit the url to authenticate: <a href="${url}">${url}</a>`);
});


// OAuth2 callback endpoint
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Missing code in query string');
  }
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    //console.log("Tokens received:", tokens); // Temporarily log tokens

    // IMPORTANT: Remove or comment out the above log statement in production

    oAuth2Client.setCredentials(tokens);

    // Securely store the refresh token for later use
    // Example: Store the refresh token in your database
    // await storeRefreshToken(tokens.refresh_token, userIdentifier);

    res.send('Authentication successful! You can close this window.');
  } catch (error) {
    console.error('Error exchanging code for tokens:', error);
    res.status(500).send('Authentication failed');
  }
});





const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));