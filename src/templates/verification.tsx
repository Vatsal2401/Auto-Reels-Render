import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import * as React from 'react';

interface VerificationEmailProps {
  userFirstname?: string;
  verificationUrl?: string;
}

export const VerificationEmail = ({
  userFirstname = 'there',
  verificationUrl = 'https://example.com',
}: VerificationEmailProps) => (
  <Html>
    <Head />
    <Preview>Verify your email for AI Reels</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Welcome to AI Reels!</Heading>
        <Text style={text}>Hi {userFirstname},</Text>
        <Text style={text}>
          Thank you for signing up. Please click the button below to verify your email address and
          get started creating amazing videos!
        </Text>
        <Section style={btnContainer}>
          <Button style={button} href={verificationUrl}>
            Verify Email Address
          </Button>
        </Section>
        <Text style={text}>
          Or copy and paste this link in your browser:
          <br />
          <a href={verificationUrl} style={link}>
            {verificationUrl}
          </a>
        </Text>
        <Hr style={hr} />
        <Text style={footer}>
          If you did not sign up for this account, you can safely ignore this email.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default VerificationEmail;

const main = {
  backgroundColor: '#f6f9fc',
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const container = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '20px 0 48px',
  marginBottom: '64px',
};

const h1 = {
  color: '#4f46e5',
  fontSize: '24px',
  fontWeight: 'bold',
  textAlign: 'center' as const,
  margin: '30px 0',
};

const text = {
  color: '#525f7f',
  fontSize: '16px',
  lineHeight: '24px',
  textAlign: 'left' as const,
  padding: '0 40px',
};

const btnContainer = {
  textAlign: 'center' as const,
  margin: '32px 0',
};

const button = {
  backgroundColor: '#4f46e5',
  borderRadius: '5px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: 'bold',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  width: '200px',
  padding: '14px 7px',
};

const link = {
  color: '#4f46e5',
  textDecoration: 'underline',
};

const hr = {
  borderColor: '#e6ebf1',
  margin: '20px 0',
};

const footer = {
  color: '#8898aa',
  fontSize: '12px',
  lineHeight: '16px',
  textAlign: 'center' as const,
  padding: '0 40px',
};
