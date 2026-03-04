'use client';

import { useEffect, useRef, useState } from 'react';

type ImageAttachmentProps = {
  url: string;
  alt: string;
};

export default function ImageAttachment({ url, alt }: ImageAttachmentProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    let disposed = false;

    const revokeBlobUrl = () => {
      if (!objectUrlRef.current) {
        return;
      }
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    };

    revokeBlobUrl();
    setBlobUrl(null);
    setLoadFailed(false);

    const loadImage = async () => {
      try {
        const response = await fetch(url, {
          credentials: 'include',
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`Image request failed with status ${response.status}`);
        }

        const blob = await response.blob();
        if (disposed) {
          return;
        }

        const nextBlobUrl = URL.createObjectURL(blob);
        objectUrlRef.current = nextBlobUrl;
        setBlobUrl(nextBlobUrl);
      } catch (error) {
        if (disposed) {
          return;
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setLoadFailed(true);
      }
    };

    void loadImage();

    return () => {
      disposed = true;
      abortController.abort();
      revokeBlobUrl();
    };
  }, [url]);

  if (blobUrl) {
    return <img src={blobUrl} alt={alt} loading="lazy" />;
  }

  if (loadFailed) {
    return (
      <div className="chat-message-attachment-fallback" aria-label={`File attachment ${alt}`}>
        FILE
      </div>
    );
  }

  return <div className="chat-message-attachment-loading" aria-hidden="true" />;
}
