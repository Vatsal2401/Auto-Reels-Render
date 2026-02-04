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
        <Text style={text}>
          Great news! Your video about <strong>"{topic}"</strong> has finished rendering and is now
          available to download or share.
        </Text>
        <Section style={btnContainer}>
          <Button style={button} href={videoUrl}>
            View Your Video
          </Button>
        </Section>
        <Text style={text}>
          Or copy and paste this link in your browser:
          <br />
          <a href={videoUrl} style={link}>
            {videoUrl}
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
