require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const nodemailer = require('nodemailer');
// Assuming you've initialized Firebase Admin SDK correctly somewhere above this line
const admin = require('firebase-admin');
const { db } = require('./firebaseAdmin');


console.log("Stripe Secret Key:", process.env.STRIPE_SECRET_KEY);

const app = express();

app.use(cors());
app.use(express.json());

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

// Setup NodeMailer transporter
let transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

app.post('/webhook', express.raw({type: 'application/json'}), async (request, response) => {
  const sig = request.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Here you can extract more details from session if needed
    // and save them to Firestore
    const orderRef = db.collection('orders').doc(session.id);
    await orderRef.set({
      customerEmail: session.customer_details.email, // or customerEmail from metadata if you stored it there
      // Add other order details you need
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Order ${session.id} saved to Firestore.`);
  }

  response.json({received: true});
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
