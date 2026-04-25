'use client';

import { ChangeEvent, FormEvent, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, Bug, Image as ImageIcon, Loader2, MessageSquareQuote, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type FeedbackCategory = 'BUG' | 'FEATURE' | 'OTHER';
type TabValue = 'feedback' | 'review';

interface FormStatus {
  type: 'success' | 'error';
  message: string;
}

export default function FeedbackPage() {
  const [activeTab, setActiveTab] = useState<TabValue>('feedback');
  const [status, setStatus] = useState<FormStatus | null>(null);
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

  const [feedbackTitle, setFeedbackTitle] = useState('');
  const [feedbackCategory, setFeedbackCategory] = useState<FeedbackCategory>('BUG');
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackScreenshotFiles, setFeedbackScreenshotFiles] = useState<File[]>([]);
  const [feedbackScreenshotPreviewUrls, setFeedbackScreenshotPreviewUrls] = useState<string[]>([]);

  const [reviewTitle, setReviewTitle] = useState('');
  const [reviewMessage, setReviewMessage] = useState('');
  const [reviewRating, setReviewRating] = useState('5');
  const [allowShowcase, setAllowShowcase] = useState(false);

  const uploadFeedbackScreenshot = async (file: File): Promise<string> => {
    const formData = new FormData();
    formData.append('image', file);

    const response = await fetch('/api/feedback/upload', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to upload screenshot');
    }

    return data.data.url as string;
  };

  const handleFeedbackScreenshotChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    if (selectedFiles.length === 0) return;

    const remainingSlots = 5 - feedbackScreenshotFiles.length;
    if (remainingSlots <= 0) {
      setStatus({ type: 'error', message: 'You can upload up to 5 screenshots.' });
      return;
    }

    const allowedFiles = selectedFiles.slice(0, remainingSlots);
    const nextFiles: File[] = [];
    const nextPreviewUrls: string[] = [];

    for (const file of allowedFiles) {
      const isImage = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type);
      if (!isImage) {
        setStatus({
          type: 'error',
          message: 'Unsupported screenshot format. Use JPG, PNG, WEBP, or GIF.',
        });
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        setStatus({ type: 'error', message: 'Each screenshot must be smaller than 10MB.' });
        continue;
      }
      nextFiles.push(file);
      nextPreviewUrls.push(URL.createObjectURL(file));
    }

    if (nextFiles.length > 0) {
      setFeedbackScreenshotFiles((prev) => [...prev, ...nextFiles]);
      setFeedbackScreenshotPreviewUrls((prev) => [...prev, ...nextPreviewUrls]);
    }
    event.target.value = '';
  };

  const removeFeedbackScreenshot = (index: number) => {
    const targetUrl = feedbackScreenshotPreviewUrls[index];
    if (targetUrl) URL.revokeObjectURL(targetUrl);
    setFeedbackScreenshotFiles((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
    setFeedbackScreenshotPreviewUrls((prev) =>
      prev.filter((_, currentIndex) => currentIndex !== index)
    );
  };

  const clearFeedbackScreenshots = () => {
    feedbackScreenshotPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    setFeedbackScreenshotFiles([]);
    setFeedbackScreenshotPreviewUrls([]);
  };

  const handleFeedbackSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus(null);
    setIsSubmittingFeedback(true);

    try {
      const screenshotUrls = await Promise.all(
        feedbackScreenshotFiles.map((file) => uploadFeedbackScreenshot(file))
      );

      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'FEEDBACK',
          category: feedbackCategory,
          title: feedbackTitle,
          message: feedbackMessage,
          screenshotUrls,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setStatus({ type: 'error', message: data.error || 'Failed to submit feedback' });
        return;
      }

      setFeedbackTitle('');
      setFeedbackCategory('BUG');
      setFeedbackMessage('');
      clearFeedbackScreenshots();
      setStatus({ type: 'success', message: 'Feedback submitted. Thank you.' });
    } catch {
      setStatus({ type: 'error', message: 'Failed to submit feedback' });
    } finally {
      setIsSubmittingFeedback(false);
    }
  };

  const handleReviewSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus(null);
    setIsSubmittingReview(true);

    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'REVIEW',
          title: reviewTitle,
          message: reviewMessage,
          rating: Number(reviewRating),
          allowShowcase,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setStatus({ type: 'error', message: data.error || 'Failed to submit review' });
        return;
      }

      setReviewTitle('');
      setReviewMessage('');
      setReviewRating('5');
      setAllowShowcase(false);
      setStatus({
        type: 'success',
        message: 'Review submitted. Thank you for sharing your experience.',
      });
    } catch {
      setStatus({ type: 'error', message: 'Failed to submit review' });
    } finally {
      setIsSubmittingReview(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] px-4 py-10">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to Dashboard
        </Link>

        <Card className="border-border/50 shadow-lg">
          <CardHeader>
            <CardTitle className="text-2xl">Feedback & Review</CardTitle>
            <CardDescription>
              Send product feedback, report bugs, or share a review we can feature on the landing
              page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {status && (
              <div
                className={`rounded-lg border px-3 py-2 text-sm ${
                  status.type === 'success'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                    : 'border-destructive/40 bg-destructive/10 text-destructive'
                }`}
              >
                {status.message}
              </div>
            )}

            <Tabs
              value={activeTab}
              onValueChange={(value) => setActiveTab(value as TabValue)}
              className="w-full"
            >
              <TabsList className="w-full">
                <TabsTrigger value="feedback" className="gap-1.5">
                  <Bug className="h-3.5 w-3.5" />
                  Feedback
                </TabsTrigger>
                <TabsTrigger value="review" className="gap-1.5">
                  <MessageSquareQuote className="h-3.5 w-3.5" />
                  Review
                </TabsTrigger>
              </TabsList>

              <TabsContent value="feedback">
                <form className="space-y-4 pt-2" onSubmit={handleFeedbackSubmit}>
                  <div className="space-y-2">
                    <Label htmlFor="feedback-title">Title</Label>
                    <Input
                      id="feedback-title"
                      value={feedbackTitle}
                      onChange={(event) => setFeedbackTitle(event.target.value)}
                      placeholder="Short summary"
                      minLength={3}
                      maxLength={120}
                      required
                      disabled={isSubmittingFeedback}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Category</Label>
                    <Select
                      value={feedbackCategory}
                      onValueChange={(value: FeedbackCategory) => setFeedbackCategory(value)}
                      disabled={isSubmittingFeedback}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="BUG">Bug report</SelectItem>
                        <SelectItem value="FEATURE">Feature request</SelectItem>
                        <SelectItem value="OTHER">Other feedback</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="feedback-message">Details</Label>
                    <Textarea
                      id="feedback-message"
                      value={feedbackMessage}
                      onChange={(event) => setFeedbackMessage(event.target.value)}
                      minLength={10}
                      maxLength={3000}
                      placeholder="Tell us what happened, what you expected, or what you want to see."
                      required
                      disabled={isSubmittingFeedback}
                      rows={6}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="feedback-screenshot">Screenshots (optional, up to 5)</Label>
                    <Input
                      id="feedback-screenshot"
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      multiple
                      onChange={handleFeedbackScreenshotChange}
                      disabled={isSubmittingFeedback || feedbackScreenshotFiles.length >= 5}
                    />
                    <p className="text-xs text-muted-foreground">
                      {feedbackScreenshotFiles.length}/5 selected
                    </p>
                    {feedbackScreenshotPreviewUrls.length > 0 && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {feedbackScreenshotPreviewUrls.map((previewUrl, index) => (
                          <div key={`${previewUrl}-${index}`} className="rounded-md border p-2">
                            <Image
                              src={previewUrl}
                              alt={`Feedback screenshot preview ${index + 1}`}
                              width={640}
                              height={360}
                              className="max-h-48 w-full rounded-sm object-contain"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="mt-2"
                              onClick={() => removeFeedbackScreenshot(index)}
                              disabled={isSubmittingFeedback}
                            >
                              <X className="mr-1.5 h-3.5 w-3.5" />
                              Remove
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <Button type="submit" disabled={isSubmittingFeedback}>
                    {isSubmittingFeedback ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ImageIcon className="mr-2 h-4 w-4" />
                    )}
                    Submit Feedback
                  </Button>
                </form>
              </TabsContent>

              <TabsContent value="review">
                <form className="space-y-4 pt-2" onSubmit={handleReviewSubmit}>
                  <div className="space-y-2">
                    <Label htmlFor="review-title">Title</Label>
                    <Input
                      id="review-title"
                      value={reviewTitle}
                      onChange={(event) => setReviewTitle(event.target.value)}
                      placeholder="Your headline"
                      minLength={3}
                      maxLength={120}
                      required
                      disabled={isSubmittingReview}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Rating</Label>
                    <Select
                      value={reviewRating}
                      onValueChange={setReviewRating}
                      disabled={isSubmittingReview}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="5">5 - Excellent</SelectItem>
                        <SelectItem value="4">4 - Very good</SelectItem>
                        <SelectItem value="3">3 - Good</SelectItem>
                        <SelectItem value="2">2 - Needs improvement</SelectItem>
                        <SelectItem value="1">1 - Poor</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="review-message">Experience</Label>
                    <Textarea
                      id="review-message"
                      value={reviewMessage}
                      onChange={(event) => setReviewMessage(event.target.value)}
                      minLength={10}
                      maxLength={3000}
                      placeholder="What has your experience been like using OpenFrame?"
                      required
                      disabled={isSubmittingReview}
                      rows={6}
                    />
                  </div>

                  <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={allowShowcase}
                      onChange={(event) => setAllowShowcase(event.target.checked)}
                      disabled={isSubmittingReview}
                    />
                    <span>
                      I allow OpenFrame to potentially showcase this review on the landing page.
                    </span>
                  </label>

                  <Button type="submit" disabled={isSubmittingReview}>
                    {isSubmittingReview ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <MessageSquareQuote className="mr-2 h-4 w-4" />
                    )}
                    Submit Review
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
