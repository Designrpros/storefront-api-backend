require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
// Assuming you've initialized Firebase Admin SDK correctly somewhere above this line
const admin = require('firebase-admin');
const { db } = require('./firebaseAdmin');


console.log("Stripe Secret Key:", process.env.STRIPE_SECRET_KEY);

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

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



// Define the shop owner's email address
const shopOwnerEmail = 'designr.pros@gmail.com';

app.post('/webhook', express.raw({type: 'application/json'}), async (request, response) => {
  // Your existing code for handling the webhook event

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Send email to the customer
    const customerEmail = {
      to: session.customer_details.email,
      from: 'designr.pros@gmail.com', // Use the email address verified with SendGrid
      subject: 'Order Confirmation',
      text: 'Thank you for your order! Your order is being processed.',
      html: '<strong>Thank you for your order! Your order is being processed.</strong>',
    };

    sgMail.send(customerEmail).then(() => {
      console.log('Confirmation email sent to customer');
    }).catch((error) => {
      console.error('Error sending email to customer:', error);
    });

    // Send email to the shop owner
    const shopOwnerEmailContent = {
      to: shopOwnerEmail,
      from: 'designr.pros@gmail.com', // Use the email address verified with SendGrid
      subject: 'New Order Received',
      text: `A new order has been received from ${session.customer_details.email}. Please check the dashboard for more details.`,
      html: `<strong>A new order has been received from ${session.customer_details.email}. Please check the dashboard for more details.</strong>`,
    };

    sgMail.send(shopOwnerEmailContent).then(() => {
      console.log('Notification email sent to shop owner');
    }).catch((error) => {
      console.error('Error sending email to shop owner:', error);
    });
  }

  const sig = request.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`⚠️ Webhook signature verification failed.`, err.message);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Send email to the customer
    const customerEmailOptions = {
      from: process.env.GMAIL_USER,
      to: session.customer_details.email, // Customer's email address from the session object
      subject: 'Order Confirmation',
      text: 'Thank you for your order! Your order is being processed.',
    };

    transporter.sendMail(customerEmailOptions, function(error, info) {
      if (error) {
        console.log('Error sending email to customer:', error);
      } else {
        console.log('Confirmation email sent to customer:', info.response);
      }
    });

    // Send email to the shop owner
    const shopOwnerEmailOptions = {
      from: process.env.GMAIL_USER,
      to: shopOwnerEmail,
      subject: 'New Order Received',
      text: `A new order has been received from ${session.customer_details.email}. Please check the dashboard for more details.`,
    };

    transporter.sendMail(shopOwnerEmailOptions, function(error, info) {
      if (error) {
        console.log('Error sending email to shop owner:', error);
      } else {
        console.log('Notification email sent to shop owner:', info.response);
      }
    });

    console.log('Checkout session completed:', session.id);
  } else {
    console.warn(`Unhandled event type ${event.type}`);
  }

  response.json({received: true});
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));