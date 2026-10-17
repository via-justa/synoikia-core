@id:call-targets
Feature: Call targets
  Before a human approves a call, core asks the plugin what the call will act on.
  The approver sees these targets, and the call runs on exactly these targets.

  Background:
    Given the instance "tasks" has the list "Groceries" with the open tasks "milk", "bread" and "eggs"
    And agent 7 belongs to the admin and may read and write

  Rule: The call runs on exactly the targets the approver saw

    Scenario: New targets after the approval stop the call
      Given agent 7 waits for the admin to approve completing "milk" in "Groceries"
      And Acme gets a second open task "milk" in "Groceries"
      When the admin approves the call and agent 7 resumes it
      Then agent 7 is told that what the call acts on changed while it waited
      And the audit log records both "milk" tasks as the targets now

    Scenario: The plugin gets exactly the approved targets
      Given agent 7 waits for the admin to approve completing "milk" in "Groceries"
      When the admin approves the call and agent 7 resumes it
      Then the list "Groceries" holds only the open tasks "bread" and "eggs"

    Scenario: A call on a list that Acme does not have is refused
      When agent 7 adds "seeds" to "Garden"
      Then agent 7 is told that the plugin cannot find the list "Garden"
