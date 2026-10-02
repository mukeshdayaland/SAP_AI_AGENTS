"! Test data shared by the rule tests and the posting test.
CLASS ltd_payment DEFINITION FINAL.
  PUBLIC SECTION.
    CONSTANTS:
      company_code TYPE bukrs VALUE '1030',
      customer     TYPE kunnr VALUE '7000000010',
      bank_account TYPE hkont VALUE '0000220001',
      currency     TYPE waers VALUE 'SAR',
      marker       TYPE bktxt VALUE 'AGPAY UNIT TEST',
      other_user   TYPE syuname VALUE 'AGPAY_TEST'.

    "! Inserts a new request as if another user had created it, so the current user may approve it.
    CLASS-METHODS request_by_other_user RETURNING VALUE(result) TYPE sysuuid_x16.
ENDCLASS.

CLASS ltd_payment IMPLEMENTATION.

  METHOD request_by_other_user.
    TRY.
        result = cl_system_uuid=>create_uuid_x16_static( ).
      CATCH cx_uuid_error.
        cl_abap_unit_assert=>fail( 'No UUID could be created for the test request' ).
    ENDTRY.
    GET TIME STAMP FIELD DATA(now).
    DATA(row) = VALUE zfi_agpay(
      payment_uuid          = result
      payment_direction     = 'I'
      company_code          = company_code
      customer              = customer
      bank_gl_account       = bank_account
      amount                = '1.00'
      currency              = currency
      posting_date          = cl_abap_context_info=>get_system_date( )
      document_date         = cl_abap_context_info=>get_system_date( )
      document_type         = 'DZ'
      reference             = 'AGPAYTEST'
      header_text           = marker
      status                = 'N'
      created_by            = other_user
      created_at            = now
      last_changed_by       = other_user
      last_changed_at       = now
      local_last_changed_at = now ).
    INSERT zfi_agpay FROM @row.
    cl_abap_unit_assert=>assert_subrc( msg = 'Test request could not be inserted' ).
  ENDMETHOD.

ENDCLASS.

"! Rules of the payment request business object, called through its public
"! behavior (EML) the way the OData service calls it. Nothing is posted and
"! every test rolls back what it changed.
CLASS ltc_payment_rules DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS teardown.

    "! A new request created by the current user through the business object.
    METHODS request_by_current_user RETURNING VALUE(result) TYPE sysuuid_x16.

    METHODS defaults_on_create FOR TESTING.
    METHODS creator_cannot_approve FOR TESTING.
    METHODS other_user_can_approve FOR TESTING.
    METHODS post_needs_approval FOR TESTING.
    METHODS rejected_cannot_be_posted FOR TESTING.
    METHODS save_rejects_incomplete FOR TESTING.
ENDCLASS.

CLASS ltc_payment_rules IMPLEMENTATION.

  METHOD teardown.
    ROLLBACK ENTITIES.
  ENDMETHOD.

  METHOD request_by_current_user.
    MODIFY ENTITIES OF zr_fi_agentpayment
      ENTITY Payment
      CREATE FIELDS ( PaymentDirection CompanyCode Customer BankGLAccount Amount Currency HeaderText )
      WITH VALUE #( ( %cid             = 'NEW'
                      PaymentDirection = 'I'
                      CompanyCode      = ltd_payment=>company_code
                      Customer         = ltd_payment=>customer
                      BankGLAccount    = ltd_payment=>bank_account
                      Amount           = '1.00'
                      Currency         = ltd_payment=>currency
                      HeaderText       = ltd_payment=>marker ) )
      MAPPED DATA(mapped)
      FAILED DATA(failed).
    cl_abap_unit_assert=>assert_initial( act = failed-payment msg = 'Creating a request failed' ).
    result = mapped-payment[ 1 ]-PaymentUUID.
  ENDMETHOD.

  METHOD defaults_on_create.
    DATA(uuid) = request_by_current_user( ).

    READ ENTITIES OF zr_fi_agentpayment
      ENTITY Payment ALL FIELDS WITH VALUE #( ( PaymentUUID = uuid ) )
      RESULT DATA(payments).

    cl_abap_unit_assert=>assert_equals( exp = 1 act = lines( payments ) ).
    DATA(payment) = payments[ 1 ].
    cl_abap_unit_assert=>assert_equals( exp = 'N' act = payment-Status msg = 'A new request starts as New' ).
    cl_abap_unit_assert=>assert_equals( exp = 'DZ' act = payment-AccountingDocumentType msg = 'An incoming payment defaults to document type DZ' ).
    cl_abap_unit_assert=>assert_equals( exp = cl_abap_context_info=>get_system_date( ) act = payment-PostingDate ).
    cl_abap_unit_assert=>assert_equals( exp = cl_abap_context_info=>get_user_technical_name( ) act = payment-CreatedBy ).
  ENDMETHOD.

  METHOD creator_cannot_approve.
    DATA(uuid) = request_by_current_user( ).

    MODIFY ENTITIES OF zr_fi_agentpayment
      ENTITY Payment EXECUTE approve FROM VALUE #( ( PaymentUUID = uuid ) )
      FAILED DATA(failed).

    cl_abap_unit_assert=>assert_not_initial( act = failed-payment msg = 'The creator must not be able to approve their own request' ).
    READ ENTITIES OF zr_fi_agentpayment
      ENTITY Payment FIELDS ( Status ) WITH VALUE #( ( PaymentUUID = uuid ) )
      RESULT DATA(payments).
    cl_abap_unit_assert=>assert_equals( exp = 'N' act = payments[ 1 ]-Status ).
  ENDMETHOD.

  METHOD other_user_can_approve.
    DATA(uuid) = ltd_payment=>request_by_other_user( ).

    MODIFY ENTITIES OF zr_fi_agentpayment
      ENTITY Payment EXECUTE approve FROM VALUE #( ( PaymentUUID = uuid ) )
      RESULT DATA(result)
      FAILED DATA(failed).

    cl_abap_unit_assert=>assert_initial( act = failed-payment msg = 'A second user must be able to approve' ).
    cl_abap_unit_assert=>assert_equals( exp = 'A' act = result[ 1 ]-%param-Status ).
    cl_abap_unit_assert=>assert_equals( exp = cl_abap_context_info=>get_user_technical_name( ) act = result[ 1 ]-%param-ApprovedBy ).
  ENDMETHOD.

  METHOD post_needs_approval.
    DATA(uuid) = ltd_payment=>request_by_other_user( ).

    MODIFY ENTITIES OF zr_fi_agentpayment
      ENTITY Payment EXECUTE post FROM VALUE #( ( PaymentUUID = uuid ) )
      FAILED DATA(failed).

    cl_abap_unit_assert=>assert_not_initial( act = failed-payment msg = 'A request that is not approved must not be posted' ).
  ENDMETHOD.

  METHOD rejected_cannot_be_posted.
    DATA(uuid) = ltd_payment=>request_by_other_user( ).

    MODIFY ENTITIES OF zr_fi_agentpayment
      ENTITY Payment EXECUTE reject FROM VALUE #( ( PaymentUUID = uuid ) )
      RESULT DATA(result)
      FAILED DATA(reject_failed).
    cl_abap_unit_assert=>assert_initial( act = reject_failed-payment ).
    cl_abap_unit_assert=>assert_equals( exp = 'R' act = result[ 1 ]-%param-Status ).

    MODIFY ENTITIES OF zr_fi_agentpayment
      ENTITY Payment EXECUTE approve FROM VALUE #( ( PaymentUUID = uuid ) )
      FAILED DATA(approve_failed).
    cl_abap_unit_assert=>assert_not_initial( act = approve_failed-payment msg = 'A rejected request must not be approved' ).

    MODIFY ENTITIES OF zr_fi_agentpayment
      ENTITY Payment EXECUTE post FROM VALUE #( ( PaymentUUID = uuid ) )
      FAILED DATA(post_failed).
    cl_abap_unit_assert=>assert_not_initial( act = post_failed-payment msg = 'A rejected request must not be posted' ).
  ENDMETHOD.

  METHOD save_rejects_incomplete.
    " An incoming payment without a customer.
    MODIFY ENTITIES OF zr_fi_agentpayment
      ENTITY Payment
      CREATE FIELDS ( PaymentDirection CompanyCode BankGLAccount Amount Currency HeaderText )
      WITH VALUE #( ( %cid             = 'BAD'
                      PaymentDirection = 'I'
                      CompanyCode      = ltd_payment=>company_code
                      BankGLAccount    = ltd_payment=>bank_account
                      Amount           = '1.00'
                      Currency         = ltd_payment=>currency
                      HeaderText       = ltd_payment=>marker ) )
      MAPPED DATA(mapped).

    COMMIT ENTITIES RESPONSE OF zr_fi_agentpayment FAILED DATA(failed) REPORTED DATA(reported).

    cl_abap_unit_assert=>assert_not_initial( act = failed-payment msg = 'An incoming payment without a customer must not be saved' ).
    SELECT COUNT(*) FROM zfi_agpay WHERE payment_uuid = @( mapped-payment[ 1 ]-PaymentUUID ) INTO @DATA(saved).
    cl_abap_unit_assert=>assert_equals( exp = 0 act = saved ).
  ENDMETHOD.

ENDCLASS.

"! Posts a real incoming payment of SAR 1.00 for customer 7000000010 in
"! company code 1030 and checks that the journal entry exists. Each run
"! leaves one FI document and its posted payment request in the system.
CLASS ltc_payment_posting DEFINITION FINAL FOR TESTING DURATION MEDIUM RISK LEVEL DANGEROUS.
  PRIVATE SECTION.
    CLASS-METHODS class_teardown.
    METHODS teardown.
    METHODS approve_and_post_creates_doc FOR TESTING.
ENDCLASS.

CLASS ltc_payment_posting IMPLEMENTATION.

  METHOD class_teardown.
    " A posted request stays as the log of its document; a request left unposted by a failed run is residue.
    DELETE FROM zfi_agpay WHERE header_text = @ltd_payment=>marker AND status <> 'P'.
    COMMIT WORK.
  ENDMETHOD.

  METHOD teardown.
    ROLLBACK ENTITIES.
  ENDMETHOD.

  METHOD approve_and_post_creates_doc.
    DATA problems TYPE string.
    DATA(uuid) = ltd_payment=>request_by_other_user( ).

    MODIFY ENTITIES OF zr_fi_agentpayment
      ENTITY Payment EXECUTE approve FROM VALUE #( ( PaymentUUID = uuid ) )
      FAILED DATA(approve_failed).
    cl_abap_unit_assert=>assert_initial( act = approve_failed-payment msg = 'Approval failed' ).

    MODIFY ENTITIES OF zr_fi_agentpayment
      ENTITY Payment EXECUTE post FROM VALUE #( ( PaymentUUID = uuid ) )
      FAILED DATA(post_failed)
      REPORTED DATA(post_reported).
    LOOP AT post_reported-payment INTO DATA(posting_message) WHERE %msg IS BOUND.
      problems = |{ problems } { posting_message-%msg->if_message~get_text( ) };|.
    ENDLOOP.
    cl_abap_unit_assert=>assert_initial( act = post_failed-payment msg = |Posting was refused:{ problems }| ).

    COMMIT ENTITIES
      RESPONSE OF zr_fi_agentpayment FAILED DATA(save_failed) REPORTED DATA(save_reported)
      RESPONSE OF i_journalentrytp FAILED DATA(journal_failed) REPORTED DATA(journal_reported).
    DATA(commit_rc) = sy-subrc.
    LOOP AT journal_reported-journalentry INTO DATA(journal_message) WHERE %msg IS BOUND.
      problems = |{ problems } { journal_message-%msg->if_message~get_text( ) };|.
    ENDLOOP.
    LOOP AT save_reported-payment INTO DATA(save_message) WHERE %msg IS BOUND.
      problems = |{ problems } { save_message-%msg->if_message~get_text( ) };|.
    ENDLOOP.
    cl_abap_unit_assert=>assert_equals( exp = 0 act = commit_rc msg = |Saving failed:{ problems }| ).

    SELECT SINGLE status, accounting_document, fiscal_year
      FROM zfi_agpay WHERE payment_uuid = @uuid
      INTO @DATA(saved).
    cl_abap_unit_assert=>assert_equals( exp = 'P' act = saved-status msg = 'The request must be marked as posted' ).
    cl_abap_unit_assert=>assert_not_initial( act = saved-accounting_document msg = 'The journal entry number must be stored on the request' ).

    SELECT SINGLE blart FROM bkpf
      WHERE bukrs = @ltd_payment=>company_code AND belnr = @saved-accounting_document AND gjahr = @saved-fiscal_year
      INTO @DATA(document_type).
    cl_abap_unit_assert=>assert_subrc( msg = |Journal entry { saved-accounting_document } does not exist in SAP| ).
    cl_abap_unit_assert=>assert_equals( exp = 'DZ' act = document_type ).
  ENDMETHOD.

ENDCLASS.
