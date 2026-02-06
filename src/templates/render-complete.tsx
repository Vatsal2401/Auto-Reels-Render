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

interface RenderCompleteEmailProps {
  userFirstname?: string;
  videoUrl?: string;
  topic?: string;
}

export const RenderCompleteEmail = ({
  userFirstname = 'there',
  videoUrl = 'https://example.com',
  topic = 'Your Video',
}: RenderCompleteEmailProps) => (
  <Html>
    <Head />
    <Preview>Your video is ready!</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Your Video is Ready!</Heading>
        <Text style={text}>Hi {userFirstname},</Text>
        <Text style={text}>Great news! Your video generation has finished successfully.</Text>

        {topic && (
          <Section style={quoteContainer}>
            <Text style={quoteText}>"{topic}"</Text>
          </Section>
        )}

        <Text style={text}>It is now available to download or share.</Text>

        <Section style={btnContainer}>
          <Button style={button} href={videoUrl}>
            View Your Video
          </Button>
        </Section>
        <Text style={text}>
          Or use this direct link:
          <br />
          <a href={videoUrl} style={link}>
            Click here to watch
          </a>
        </Text>
        <Hr style={hr} />
        <Text style={footer}>AI Reels - Create amazing content in seconds.</Text>
      </Container>
    </Body>
  </Html>
);

export default RenderCompleteEmail;

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
  borderRadius: '8px',
  boxShadow: '0 4px 6px rgba(0,0,0,0.05)',
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
  marginBottom: '16px',
};

const quoteContainer = {
  backgroundColor: '#f9fafb',
  borderLeft: '4px solid #4f46e5',
  margin: '0 40px 24px 40px',
  padding: '16px 20px',
  borderRadius: '4px',
};

const quoteText = {
  color: '#4b5563',
  fontSize: '15px',
  fontStyle: 'italic',
  lineHeight: '24px',
  margin: '0',
};

const btnContainer = {
  textAlign: 'center' as const,
  margin: '32px 0',
};

const button = {
  backgroundColor: '#4f46e5',
  borderRadius: '6px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '12px 24px',
  boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
};

const link = {
  color: '#4f46e5',
  textDecoration: 'underline',
  fontSize: '14px',
};

const hr = {
  borderColor: '#e6ebf1',
  margin: '32px 0 20px',
};

const footer = {
  color: '#8898aa',
  fontSize: '12px',
  lineHeight: '16px',
  textAlign: 'center' as const,
  padding: '0 40px',
};
