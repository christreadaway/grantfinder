'use client'

import { useState } from 'react'
import type { Question } from '@/types'
import { Input } from '@/components/ui/Input'

interface QuestionnaireProps {
  questions: Question[]
  answers: Record<string, any>
  onAnswersChange: (answers: Record<string, any>) => void
}

export function Questionnaire({ questions, answers, onAnswersChange }: QuestionnaireProps) {
  const updateAnswer = (questionId: string, value: any) => {
    onAnswersChange({ ...answers, [questionId]: value })
  }

  // Group questions by topic
  const groupedQuestions = questions.reduce(
    (acc, q) => {
      if (!acc[q.topic]) acc[q.topic] = []
      acc[q.topic].push(q)
      return acc
    },
    {} as Record<string, Question[]>
  )

  // Check if a question should be shown based on conditional logic
  const shouldShowQuestion = (question: Question) => {
    if (!question.conditional) return true
    const dependsOnValue = answers[question.conditional.depends_on]
    return dependsOnValue === question.conditional.show_if
  }

  return (
    <div className="space-y-8">
      {Object.entries(groupedQuestions).map(([topic, topicQuestions]) => (
        <div key={topic}>
          <h3 className="text-lg font-semibold text-gray-200 mb-4 border-b border-gray-700 pb-2">
            {topic}
          </h3>
          <div className="space-y-6">
            {topicQuestions.map((question) => {
              if (!shouldShowQuestion(question)) return null

              return (
                <QuestionField
                  key={question.id}
                  question={question}
                  value={answers[question.id]}
                  onChange={(value) => updateAnswer(question.id, value)}
                />
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

interface QuestionFieldProps {
  question: Question
  value: any
  onChange: (value: any) => void
}

function QuestionField({ question, value, onChange }: QuestionFieldProps) {
  switch (question.type) {
    case 'yes_no':
      return (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-300">{question.text}</label>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={question.id}
                checked={value === true}
                onChange={() => onChange(true)}
                className="w-4 h-4 text-blue-600"
              />
              <span className="text-gray-300">Yes</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={question.id}
                checked={value === false}
                onChange={() => onChange(false)}
                className="w-4 h-4 text-blue-600"
              />
              <span className="text-gray-300">No</span>
            </label>
          </div>
        </div>
      )

    case 'multiple_choice':
      return (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-300">{question.text}</label>
          <select
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full rounded-lg border border-gray-600 bg-gray-800 px-4 py-2 text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          >
            <option value="">Select an option...</option>
            {question.options?.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      )

    case 'number':
      return (
        <Input
          type="number"
          label={question.text}
          value={value || ''}
          onChange={(e) => onChange(e.target.value ? parseInt(e.target.value) : undefined)}
        />
      )

    case 'text':
    default:
      return (
        <Input
          type="text"
          label={question.text}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}
