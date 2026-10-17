@id:call-pipeline
Feature: Call pipeline
  Every call of the agent's code goes through the gate, one at a time.
  The agent gets a clear answer for each call, and the audit log records it.
  An upstream failure never shows a secret.

  Background:
    Given the instance "tasks" has the list "Groceries" with the open tasks "milk", "bread" and "eggs"
    And agent 7 belongs to the admin and may read and write

  Rule: Reads run at once and are recorded

    Scenario: A read runs at once
      When agent 7 asks for the open tasks of "Groceries"
      Then agent 7 gets "milk", "bread" and "eggs"
      And the audit log shows that "show the open tasks" ran at once

    Scenario: A read hides the share password
      Given the list "Groceries" has the share password "groceries-share-7"
      When agent 7 asks for the share password of "Groceries"
      Then agent 7 sees the share password of "Groceries" as [REDACTED]

  Rule: An operation the plugin does not know is refused

    Scenario: An unknown operation is refused and recorded
      When agent 7 calls the operation "archive everything"
      Then agent 7 is told that "archive everything" is an unknown operation
      And the audit log records the unknown operation as refused

  Rule: The agent's code can catch a refusal

    Scenario: The code catches a refusal and reads its reason
      Given the admin sets the group "tasks" of "tasks" to none
      When the code of agent 7 adds "butter" to "Groceries" and catches the refusal
      Then the code of agent 7 reads that the access level is none

    Scenario: A refusal the code does not catch ends the run
      Given the admin sets the group "tasks" of "tasks" to none
      When agent 7 adds "butter" to "Groceries"
      Then agent 7 is told that the admin turned the operation off

    Scenario: A failure inside core shows only a short message
      When the search code of agent 7 looks in the registry with the scope name "Bad Scope"
      Then agent 7 is told only that there was an internal error

  Rule: Upstream failures become clear errors without secrets

    Scenario: Acme refuses the call for lack of permission
      Given Acme refuses every request for lack of permission
      When agent 7 asks for the open tasks of "Groceries"
      Then agent 7 is told that Acme denied the call for lack of permission
      And the audit log records the read of "show the open tasks" as an error

    Scenario: The plugin is down
      Given the plugin of "tasks" is down
      When agent 7 counts the open tasks of "Groceries"
      Then agent 7 is told that the plugin is not available

    Scenario: An upstream error hides the API token
      Given Acme answers every request with an error that quotes the API token
      When agent 7 asks for the open tasks of "Groceries"
      Then agent 7 is told that Acme answered "token [REDACTED] is not valid for this list"

  Rule: The calls of one run go one at a time

    Scenario: A second write waits until the first is decided
      When agent 7 adds "butter" and "jam" to "Groceries" at the same time, and the admin approves the first add
      Then agent 7 was first asked about "butter" alone, and then about "jam"

  Rule: A run ends with its code

    Scenario: A call the code does not wait for never reaches Acme
      Given the admin sets the group "tasks" of "tasks" to write
      When the code of agent 7 starts to add "butter" to "Groceries" and returns without waiting
      Then Acme never receives "butter"
      And the audit log shows that the add of "butter" ended with its run

    Scenario: A call the code does not wait for asks nobody
      When the code of agent 7 starts to add "butter" to "Groceries" and returns without waiting
      Then the audit log shows that the add of "butter" ended with its run
      And nobody was asked to approve the add of "butter"

    Scenario: A cancelled request ends the run and its approval
      Given the app of agent 7 shows approval links
      When agent 7 cancels its request while the add of "butter" to "Groceries" waits for approval
      Then the approval link of the add no longer opens
      And the audit log shows that the add of "butter" ended with its run

  Rule: A call runs only on the plugin version that the catalog describes

    Scenario: A plugin update during an approval stops the call
      Given agent 7 waits for the admin to approve the add of "butter" to "Groceries"
      And the plugin of "tasks" was updated to version 1.1.0
      When the admin approves the call and agent 7 resumes it
      Then agent 7 is told that the plugin changed while the call waited
      And Acme never receives "butter"

    Scenario: A plugin whose operations core cannot read refuses even a read
      Given agent 7 has an open session on "tasks"
      And the plugin of "tasks" was updated to version 1.1.0, and it cannot list its operations
      When agent 7 counts the open tasks of "Groceries"
      Then agent 7 is told that the plugin is not available

    Scenario: Each call that reaches Acme has its own call id
      When agent 7 counts the open tasks of "Groceries" twice in one run
      Then Acme sees a different call id on each of the 2 calls

  Rule: A slow upstream gives an unknown result

    @backlog
    Scenario: Acme does not answer in time
      Given the admin sets the group "tasks" of "tasks" to write
      And a run on "tasks" may take 1 second, and Acme takes 3 seconds to answer
      When agent 7 adds "butter" to "Groceries"
      Then agent 7 is told that the result of the add is unknown
      And the audit log records the add of "butter" as timed out
