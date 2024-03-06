require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

app.use(cors());

// Apply JSON middleware for all routes except for the webhook route
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next(); // Skip it for webhook route
  } else {
    express.json()(req, res, next); // Apply for all other routes
  }
});

// Endpoint for creating a Stripe Checkout session
app.post('/create-checkout-session', async (req, res) => {
  const { cartItems, shippingDetails } = req.body;

  // Convert cart items to Stripe line items format...
  const lineItems = cartItems.map(item => ({
    price_data: {
      currency: 'nok',
      product_data: { name: item.name },
      unit_amount: Math.round(parseFloat(item.price) * 100), // Convert to smallest currency unit
    },
    quantity: item.quantity,
  }));

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${req.headers.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/cancel`,
      shipping_address_collection: { allowed_countries: ['NO'] },
      metadata: { customerEmail: shippingDetails.email }, // Optional: Add additional metadata here
    });

    res.json({ id: session.id });
  } catch (error) {
    console.error("Error creating Stripe checkout session:", error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook endpoint for Stripe
app.post('/webhook', express.raw({type: 'application/json'}), async (request, response) => {
  const sig = request.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`⚠️ Webhook signature verification failed.`, err.message);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log(`🔔 Payment for session ${session.id} received!`);
    // Handle successful checkout session completion here (e.g., update order status)
  } else {
    console.warn(`Unhandled event type ${event.type}`);
  }

  response.json({received: true}); // Acknowledge receipt of the event
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
